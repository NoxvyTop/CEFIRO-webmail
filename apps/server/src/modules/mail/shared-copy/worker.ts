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
 * `stop()` closes every watcher, cancels the poll and waits for the cycle in
 * flight, so the shutdown path (core/shutdown.ts stopWorkers) never drains the
 * listener under a half-finished page.
 *
 * Timers, the cycle and the watcher factory are injected so all of the above
 * runs under test with no clock, no JMAP and no sockets.
 */

import { log as defaultLog } from "../../../core/logger";
import type { JmapAuthMode } from "../../../infra/jmap/client";
import {
  electWatcher,
  runDeliveryCycle,
  staleMsForPoll,
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

export type WatcherFactoryInput = {
  sharedAccountId: string;
  resolveWatcher: () => ReturnType<typeof electWatcher>;
  onChange: (sharedAccountId: string) => void;
};

export type SharedCopyWorkerInput = {
  delivery: DeliveryDeps;
  /** infra/repos/user-preferences.ts listSharedMailboxCopyOptIns. */
  listOptIns(): Promise<SharedCopyOptIn[]>;
  pollMs: number;
  /** For the default watcher factory: how the subscription dials the provider. */
  fetchFn?: typeof fetch;
  authMode?: JmapAuthMode;
  timers?: WatcherTimers;
  log?: LogFn;
  /** Injectable for tests; defaults to ../delivery.ts runDeliveryCycle. */
  runCycle?: (
    deps: DeliveryDeps,
    input: { sharedAccountId: string; members: SharedCopyMember[] },
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
    // Derived from the poll interval, not configured separately: an operator
    // who lengthens the poll means the cycles to be further apart, and a fixed
    // window would start calling their normal resumes a backlog.
    staleMs: input.delivery.staleMs ?? staleMsForPoll(input.pollMs),
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
  const watchers = new Map<string, Pick<SharedMailboxWatcher, "stop">>();
  const queue = new Set<string>();
  let draining: Promise<void> | null = null;
  let pollTimer: unknown;

  async function cycleFor(sharedAccountId: string): Promise<void> {
    const members = membership.get(sharedAccountId);
    // An account nobody opts into any more can still be signalled by a
    // watcher that was closed a moment ago; there is nobody to copy for.
    if (!members || members.length === 0) return;
    try {
      const result = await runCycle(delivery, { sharedAccountId, members });
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

  function reconcileWatchers(): void {
    for (const [accountId, watcher] of watchers) {
      if (membership.has(accountId)) continue;
      watcher.stop();
      watchers.delete(accountId);
      log("info", "shared mailbox watch: closed, nobody opts in", { sharedAccountId: accountId });
    }
    for (const accountId of membership.keys()) {
      if (watchers.has(accountId)) continue;
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
  }

  async function poll(): Promise<void> {
    if (stopped) return;
    try {
      membership = membersByAccount(await input.listOptIns());
      reconcileWatchers();
      for (const accountId of membership.keys()) queue.add(accountId);
      await drain();
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
      if (draining) await draining;
      if (started) log("info", "shared mailbox copy: worker stopped", {});
    },
    get watching(): string[] {
      return [...watchers.keys()];
    },
  };
}
