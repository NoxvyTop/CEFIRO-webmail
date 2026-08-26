/**
 * The scheduler around the shared-mailbox delivery cycle (GH #313) — the one
 * piece of background work this server runs.
 *
 * On start and on every poll it asks the preferences repo who opted into
 * what, runs one delivery cycle per shared account (sequentially — the
 * cycles share the JMAP provider and the pool, and a burst of parallel
 * cycles would be a burst of parallel Email/copy against the same
 * provider), and reconciles the push watchers: one ../watcher.ts
 * subscription per account somebody opts into, closed as soon as nobody does.
 *
 * The trigger is a HYBRID, chosen by the owner: push for latency, poll for
 * safety.
 *
 * - The watcher fires a cycle the moment the shared account's Email state
 *   changes, so a copy lands within seconds of the mail. It is also what can
 *   be missed: a push during a reconnect, a replica that was down, a
 *   provider that dropped the stream.
 * - The poll (SHARED_MAILBOX_COPY_POLL_MS, five minutes by default) runs the
 *   cycle for every account regardless, so anything the push missed is
 *   delivered within the interval. Because the cycle reads from a cursor
 *   (../delivery.ts), a poll that finds nothing new costs one `Email/changes`
 *   per account and nothing else.
 * - Either trigger runs a cycle only when the PREFERENCE membership is known.
 *   That listing is what tells the cycle whom it owes a copy, so a poll whose
 *   listing failed skips its cycles (the watchers stay open) and a push before
 *   the first successful listing is skipped too. The cursor advances past a
 *   page whatever happens, so a cycle run without that answer would leave no
 *   trail for the members missing from it — one interval of latency against
 *   somebody's mail.
 *
 * A pure poll was rejected for the latency (five minutes is too slow for a
 * "new mail in ventas@" copy, and polling every few seconds multiplies
 * provider load by the number of shared mailboxes). A pure push was rejected
 * for the gap above. JMAP `PushSubscription` (RFC 8620 §7.2 — a true webhook
 * from the provider) would remove the held socket entirely, but needs an
 * inbound HTTPS endpoint the provider can reach plus its verification
 * handshake, so it is documented as a future option and not built here.
 *
 * Pushes are folded into a single-flight queue per process: a change that
 * arrives while that account's cycle is running marks it for ONE follow-up
 * cycle, however many changes arrive meanwhile — the cycle reads everything
 * since its cursor anyway, so the follow-up picks all of them up. Across
 * replicas the cycle's own per-account lease serialises delivery; watchers may
 * be duplicated per replica by design (each replica holds its own sockets),
 * and the lease plus the ledger are what keep a message from being copied
 * twice. The lease is taken under one id per process, minted here.
 *
 * `stop()` closes every watcher, cancels the poll timer and waits for the poll
 * and the cycle in flight, so the shutdown path (core/shutdown.ts stopWorkers)
 * never drains the listener under a half-finished page. A poll re-checks
 * `stopped` after every await: it used to check only at the top, so a stop()
 * that landed while the opt-ins were being listed or membership reconciled was
 * followed by the watcher reconcile regardless, which reopened watchers into
 * the map stop() had just emptied and left sockets and reconnect timers behind
 * a "stopped" worker.
 *
 * Timers, the cycle and the watcher factory are injected so all of the above
 * runs under test with no clock, no JMAP and no sockets.
 */

import { log as defaultLog } from "../../../core/logger";
import type { JmapAuthMode } from "../../../infra/jmap/client";
import {
  electWatcher,
  runDeliveryCycle,
  type DeliveryCycleResult,
  type DeliveryDeps,
  type SharedCopyMember,
} from "./delivery";
import {
  createSharedMailboxWatcher,
  realTimers,
  type SharedMailboxWatcher,
  type WatcherTimers,
} from "./watcher";

type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export type SharedCopyOptIn = { userId: string; email: string; accountIds: string[] };

/** A user whose preference names these shared accounts, deliverable or not. */
export type SharedCopyMembership = { userId: string; accountIds: string[] };

export type WatcherFactoryInput = {
  sharedAccountId: string;
  resolveWatcher: () => ReturnType<typeof electWatcher>;
  onChange: (sharedAccountId: string) => void;
};

export type SharedCopyWorkerInput = {
  delivery: DeliveryDeps;
  /**
   * infra/repos/user-preferences.ts listSharedMailboxCopyOptIns: the members
   * a cycle can DELIVER to right now (active, with a credential).
   */
  listOptIns(): Promise<SharedCopyOptIn[]>;
  /**
   * infra/repos/user-preferences.ts listSharedMailboxCopyOptInMembership:
   * everybody whose preference names an account, deliverable or not. What
   * the member prune is reconciled against — see `reconcileMembers`.
   */
  listOptInMembership(): Promise<SharedCopyMembership[]>;
  pollMs: number;
  /** For the default watcher factory: how the subscription dials the provider. */
  fetchFn?: typeof fetch;
  authMode?: JmapAuthMode;
  timers?: WatcherTimers;
  log?: LogFn;
  /** Injectable for tests; defaults to ../delivery.ts runDeliveryCycle. */
  runCycle?: (
    deps: DeliveryDeps,
    input: {
      sharedAccountId: string;
      members: SharedCopyMember[];
      owedMembers: string[];
    },
  ) => Promise<DeliveryCycleResult>;
  /** Injectable for tests; defaults to a started ../watcher.ts subscription. */
  openWatcher?: (input: WatcherFactoryInput) => Pick<SharedMailboxWatcher, "stop">;
  /**
   * Who this process is when a cycle takes an account's delivery lease
   * (../delivery.ts). Defaults to a fresh `crypto.randomUUID()` per worker,
   * which is per PROCESS — every replica is a different holder, and this
   * process re-entering its own lease is recognised as the same one.
   * Injectable so a test can stand in for a second replica.
   */
  leaseOwner?: string;
};

export type SharedCopyWorker = {
  start(): void;
  stop(): Promise<void>;
  /** Shared accounts with a watcher open right now, for logs and tests. */
  readonly watching: string[];
};

/** Members per shared account, from the flat per-user listing. */
function membersByAccount(optIns: SharedCopyOptIn[]): Map<string, SharedCopyMember[]> {
  const byAccount = new Map<string, SharedCopyMember[]>();
  for (const { userId, email, accountIds } of optIns) {
    for (const accountId of accountIds) {
      const members = byAccount.get(accountId) ?? [];
      members.push({ userId, email });
      byAccount.set(accountId, members);
    }
  }
  return byAccount;
}

/** User ids per shared account, from the flat preference membership listing. */
function membershipByAccount(membership: SharedCopyMembership[]): Map<string, string[]> {
  const byAccount = new Map<string, string[]>();
  for (const { userId, accountIds } of membership) {
    for (const accountId of accountIds) {
      const userIds = byAccount.get(accountId) ?? [];
      userIds.push(userId);
      byAccount.set(accountId, userIds);
    }
  }
  return byAccount;
}

export function createSharedCopyWorker(input: SharedCopyWorkerInput): SharedCopyWorker {
  const timers = input.timers ?? realTimers;
  const log = input.log ?? defaultLog;
  const runCycle = input.runCycle ?? runDeliveryCycle;
  // Minted once, here, for the life of the process: every cycle this worker
  // runs takes its account's lease under the same owner, and any other replica
  // takes it under a different one.
  const delivery: DeliveryDeps = {
    ...input.delivery,
    leaseOwner: input.leaseOwner ?? input.delivery.leaseOwner ?? crypto.randomUUID(),
  };
  const openWatcher =
    input.openWatcher ??
    ((factoryInput: WatcherFactoryInput) => {
      const watcher = createSharedMailboxWatcher({
        ...factoryInput,
        fetchFn: input.fetchFn,
        authMode: input.authMode,
        timers,
        log,
      });
      watcher.start();
      return watcher;
    });

  let started = false;
  let stopped = false;
  let membership = new Map<string, SharedCopyMember[]>();
  /**
   * User ids per account as the PREFERENCE names them, deliverable or not,
   * refreshed by `reconcileMembers` on every poll. Kept because the cycle
   * needs the difference — the members it OWES a copy — and a push that
   * arrives between polls runs a cycle from the last listing, exactly as it
   * does with `membership`.
   */
  let preferenceMembers = new Map<string, string[]>();
  /**
   * Whether that listing has EVER been read. The map above starts empty and an
   * empty map is indistinguishable from "nobody opts in", so a cycle run before
   * the first listing succeeded would owe a copy to nobody at all — and the
   * cursor advances past their mail regardless. A push before that point is
   * skipped rather than served from an answer nobody has given yet.
   */
  let membershipLoaded = false;
  const watchers = new Map<string, Pick<SharedMailboxWatcher, "stop">>();
  const queue = new Set<string>();
  let draining: Promise<void> | null = null;
  /** The poll in flight, for stop() to wait on; null between polls. */
  let polling: Promise<void> | null = null;
  let pollTimer: unknown;

  async function cycleFor(sharedAccountId: string): Promise<void> {
    if (!membershipLoaded) {
      // A push can arrive before the first poll has read the preference
      // membership — or after one that failed. Running the cycle anyway would
      // hand it an empty owed list, and the cursor would advance past the mail
      // of every member the deliverable listing leaves out with nothing
      // written for them. The next poll runs the cycle from a real answer.
      log("warn", "shared mailbox copy: membership unknown; cycle skipped", { sharedAccountId });
      return;
    }
    const members = membership.get(sharedAccountId);
    // An account nobody opts into any more can still be signalled by a
    // watcher that was closed a moment ago; there is nobody to copy for.
    if (!members || members.length === 0) return;
    // Members by preference, minus the ones the cycle can deliver to: the
    // people it owes a copy. Without them the cycle never heard of a member it
    // could not serve, so the cursor moved past their mail with nothing
    // written and that page was theirs to lose (see `reconcileMembers`).
    const deliverable = new Set(members.map((member) => member.userId));
    const owedMembers = (preferenceMembers.get(sharedAccountId) ?? []).filter(
      (userId) => !deliverable.has(userId),
    );
    try {
      const result = await runCycle(delivery, { sharedAccountId, members, owedMembers });
      log("debug", "shared mailbox copy: cycle result", { sharedAccountId, ...result });
    } catch (error) {
      log("error", "shared mailbox copy: cycle failed", {
        sharedAccountId,
        error: String(error),
      });
    }
  }

  /**
   * Runs queued cycles one at a time. Re-entrant callers get the promise of
   * the loop already running; whatever they enqueued is picked up by it, or by
   * the follow-up drain the `finally` starts if the loop had just finished.
   */
  function drain(): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
      while (!stopped) {
        const next = queue.values().next();
        if (next.done) break;
        queue.delete(next.value);
        await cycleFor(next.value);
      }
    })().finally(() => {
      draining = null;
      if (!stopped && queue.size > 0) void drain();
    });
    return draining;
  }

  function enqueue(sharedAccountId: string): void {
    if (stopped) return;
    queue.add(sharedAccountId);
    void drain();
  }

  /**
   * Brings every account the state store knows about into line with the
   * opt-ins just listed, BEFORE any cycle runs.
   *
   * The prune used to live inside the delivery cycle, and a cycle only runs
   * for an account that still has members — so the last member to opt out kept
   * their baseline row and their open ledger rows indefinitely: opting back in
   * resumed across the gap instead of starting fresh, and the retry pass
   * back-filled them from copies that had failed before they left. Asking the
   * store which accounts it holds state for is what reaches those accounts;
   * the worker's own membership map cannot, because an account nobody opts
   * into is not in it.
   *
   * Reconciled against the PREFERENCE membership, not the deliverable list
   * the cycles run for: that list filters `active` and joins the credential,
   * so a member deactivated for an afternoon, or momentarily without a
   * credential, read as "opted out" and lost their baseline and their owed
   * `pending`/`failed` rows. Such a member is neither delivered to nor pruned.
   *
   * That listing is also what the cycle is told it OWES a copy to (see
   * `cycleFor`): keeping the baseline was only half of "when they are back,
   * delivery resumes where it left off", because the cursor advances page by
   * page while they are away and nothing remembers a page it has passed. The
   * cycle now writes them a `failed` row per message of every page, with no
   * attempt spent, and its retry pass delivers those rows the moment the
   * member is deliverable again.
   *
   * Idempotent by construction: an account whose members did not change has
   * nothing to prune, so this is a no-op statement per account per poll.
   */
  async function reconcileMembers(): Promise<void> {
    const members = membershipByAccount(await input.listOptInMembership());
    preferenceMembers = members;
    // The listing itself is what the cycles depend on; the prunes below are
    // per-account best effort and one that fails costs a baseline row five
    // minutes, not the cycle its owed members.
    membershipLoaded = true;
    for (const accountId of await delivery.copies.listAccountIds()) {
      if (stopped) return;
      try {
        await delivery.copies.pruneMembers(accountId, members.get(accountId) ?? []);
      } catch (error) {
        // Per account: one prune that fails is one member who keeps a
        // baseline row for another five minutes, and it must not also cost
        // every account after it in the listing its prune.
        log("error", "shared mailbox copy: membership reconcile failed", {
          sharedAccountId: accountId,
          error: String(error),
        });
      }
    }
  }

  /**
   * Opens a watcher for `accountId` into the map — unless the worker is
   * stopped, in which case nothing may be opened: a watcher opened after
   * stop() emptied the map would be a socket and a reconnect timer nobody
   * closes.
   */
  function openWatcherFor(accountId: string): void {
    if (stopped) return;
    watchers.set(
      accountId,
      openWatcher({
        sharedAccountId: accountId,
        // Reads the CURRENT membership on every election, so a watcher that
        // outlives a member's opt-in never needs rebuilding.
        resolveWatcher: () =>
          electWatcher(delivery, {
            sharedAccountId: accountId,
            members: membership.get(accountId) ?? [],
          }),
        onChange: enqueue,
      }),
    );
  }

  function reconcileWatchers(): void {
    if (stopped) return;
    for (const [accountId, watcher] of watchers) {
      if (membership.has(accountId)) continue;
      watcher.stop();
      watchers.delete(accountId);
      log("info", "shared mailbox watch: closed, nobody opts in", { sharedAccountId: accountId });
    }
    for (const accountId of membership.keys()) {
      if (watchers.has(accountId)) continue;
      openWatcherFor(accountId);
    }
  }

  /**
   * One pass: list, reconcile, cycle, schedule the next. `stopped` is
   * re-checked after EVERY await, because stop() can land under any of them
   * and everything after it must then be a no-op.
   */
  async function pollOnce(): Promise<void> {
    try {
      const optIns = await input.listOptIns();
      if (stopped) return;
      membership = membersByAccount(optIns);
      let membershipKnown = true;
      try {
        await reconcileMembers();
      } catch (error) {
        // The PREFERENCE membership listing failed (a prune that fails is
        // caught per account). That listing is what tells the cycle whom it
        // owes a copy, and `preferenceMembers` is only assigned once it
        // resolves — so the cycles of this poll would run over an empty map on
        // the first poll, or a stale one on any later poll, and the cursor
        // would advance past the mail of every member missing from it with
        // nothing written for them. Skipped instead, and tried again next
        // poll: a deferred cycle costs one interval of latency, a cycle run
        // from an answer we do not have costs somebody their mail.
        membershipKnown = false;
        log("error", "shared mailbox copy: membership unknown; cycles skipped this poll", {
          error: String(error),
        });
      }
      if (stopped) return;
      // The watchers stand either way: they are reconciled from the opt-in
      // listing, which did answer, and closing them would only cost us the
      // pushes that tell the next poll there is something to deliver.
      reconcileWatchers();
      if (membershipKnown) {
        for (const accountId of membership.keys()) queue.add(accountId);
        await drain();
      }
    } catch (error) {
      // The listing is the one step that can fail here (cycles catch their
      // own): keep the previous membership and watchers, and try again next
      // poll rather than tearing down subscriptions over a database blip.
      log("error", "shared mailbox copy: opt-in listing failed", { error: String(error) });
    }
    if (stopped) return;
    pollTimer = timers.setTimer(() => {
      pollTimer = undefined;
      void poll();
    }, input.pollMs);
  }

  function poll(): Promise<void> {
    if (stopped) return Promise.resolve();
    const run = pollOnce().finally(() => {
      if (polling === run) polling = null;
    });
    polling = run;
    return run;
  }

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      log("info", "shared mailbox copy: worker started", { pollMs: input.pollMs });
      void poll();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== undefined) timers.clearTimer(pollTimer);
      pollTimer = undefined;
      for (const [accountId, watcher] of watchers) {
        watcher.stop();
        watchers.delete(accountId);
      }
      queue.clear();
      // The poll in flight first — it may still be listing or reconciling,
      // and every step after its next await is a no-op now — then whatever
      // a push started draining outside a poll.
      if (polling) await polling;
      if (draining) await draining;
      if (started) log("info", "shared mailbox copy: worker stopped", {});
    },
    get watching(): string[] {
      return [...watchers.keys()];
    },
  };
}
