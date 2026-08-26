/**
 * One delivery cycle for one shared mailbox (GH #313): find what arrived in
 * the shared account since the last cycle and copy it, with each opted-in
 * member's OWN credential, into that member's personal inbox.
 *
 * This is the whole of "automatic copy delivery" — the worker (./worker.ts)
 * and the push watcher (./watcher.ts) only decide WHEN to run it. Kept free of
 * timers, sockets and process state so it is a plain async function over
 * injected dependencies: a JMAP client, the cursor/ledger repo, and the
 * session lookup from ../context.ts.
 *
 * Why a cursor over `Email/changes` and not "list the newest N messages":
 * `Email/changes { sinceState }` (RFC 8621 §4.6) returns exactly the ids
 * created since a state the server itself handed out, so a message is seen
 * once, regardless of how many arrived or how long the worker was down. A
 * newest-N read would either miss a burst larger than N or re-examine the
 * same N on every cycle, and could never say "these are new" — it would
 * need the ledger for everything instead of only for crash replays.
 *
 * Why the WATCHER's credential reads the shared account: there is no group
 * credential (spike G-0 — a group principal cannot log in), so the changes
 * feed has to be read through some member's session. Any opted-in member
 * whose session reaches the account will do; the first such member in the
 * (email-ordered) list is elected, and re-elected every cycle, so a member
 * who leaves or whose credential is revoked costs nothing but a warn line
 * and the next member up. The read is the same one that member's own client
 * makes when it opens the shared mailbox.
 *
 * Why copies still go through EACH member's credential, not the watcher's:
 * Email/copy targets the member's personal account, which only their own
 * session can write to. It also keeps the quota, the flags and the audit
 * trail exactly where the manual button (../router.ts copy-to-inbox) puts
 * them, because it IS the manual button's copy — ./copy.ts.
 *
 * Failure model, in one place:
 * - no member can reach the account → `no_watcher`, nothing touched;
 * - another replica (or this one) is mid-cycle → `locked`, nothing touched;
 * - no cursor → record the current state, copy NOTHING (`baselined`): the
 *   opt-in is forward-looking, and historic mail stays reachable through the
 *   manual copy;
 * - the provider no longer has history from the cursor (`cannotCalculateChanges`)
 *   → re-baseline, warn, copy nothing: the mail in that gap is unknowable, and
 *   guessing at it (a newest-N sweep) would deliver duplicates for the part
 *   the previous cycles already copied;
 * - any other provider error → propagate WITHOUT advancing the cursor, so the
 *   same page is retried on the next poll or push;
 * - one member's copy fails (refused, thrown, no session) → counted, logged,
 *   the next member is served, and the cursor still advances — the LEDGER is
 *   what protects a member's copy across cycles, not the cursor, and pinning
 *   a page behind one member's failure would starve everyone else's mail.
 */

import { log as defaultLog } from "../../../core/logger";
import { recordSharedMailboxCopy } from "../../../core/metrics";
import { JmapMethodError, type JmapAuth, type JmapClient, type JmapSession } from "../../../infra/jmap/client";
import type { MailSessionResult } from "../context";
import { copyEmailToPersonalInbox } from "./copy";

/**
 * Pages of `Email/changes` one cycle consumes before yielding. Bounds the
 * time a cycle holds the account lock and the work one push can trigger; a
 * burst larger than 5 × maxChanges is simply finished by the next poll, with
 * the cursor already advanced past what this one did.
 */
export const DELIVERY_MAX_PAGES = 5;

/** `maxChanges` asked of `Email/changes` per page. */
export const DELIVERY_PAGE_SIZE = 100;

export type SharedCopyMember = { userId: string; email: string };

type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

/** The slice of infra/repos/shared-mailbox-copies.ts the cycle uses. */
export type SharedCopyStore = {
  getCursor(sharedAccountId: string): Promise<string | null>;
  setCursor(sharedAccountId: string, emailState: string): Promise<void>;
  hasCopies(userId: string, sharedAccountId: string, emailIds: string[]): Promise<Set<string>>;
  recordCopy(userId: string, sharedAccountId: string, emailId: string): Promise<void>;
  withAccountLock<T>(sharedAccountId: string, fn: () => Promise<T>): Promise<T | null>;
};

export type DeliveryDeps = {
  jmap: JmapClient;
  copies: SharedCopyStore;
  /** ../context.ts getMailSession, bound to its deps. */
  getMailSession(member: SharedCopyMember): Promise<MailSessionResult>;
  log?: LogFn;
  /**
   * Observed once per attempted copy. Defaults to the `/metrics` facade
   * (core/metrics.ts recordSharedMailboxCopy), which is a no-op until an app
   * registers a registry — so a unit test records into nowhere unless it
   * injects its own.
   */
  onCopyResult?(result: "copied" | "failed" | "skipped"): void;
};

export type ElectedWatcher = {
  member: SharedCopyMember;
  auth: JmapAuth;
  session: JmapSession;
};

export type DeliveryCycleResult =
  | { status: "no_watcher" }
  | { status: "locked" }
  | { status: "baselined"; reason: "no_cursor" | "cannot_calculate_changes" }
  | {
      status: "delivered";
      copied: number;
      skipped: number;
      failed: number;
      pages: number;
      /** True when the page cap stopped the cycle with changes still pending. */
      truncated: boolean;
    };

function reaches(session: JmapSession, sharedAccountId: string): boolean {
  return (session.accounts ?? []).some((account) => account.id === sharedAccountId);
}

/**
 * A member's auth + session if they can take part in this account's delivery
 * right now, or null with the reason logged. Shared by the watcher election
 * and the per-member copy loop so "can this member reach the account" is
 * answered the same way in both.
 */
async function resolveMember(
  deps: DeliveryDeps,
  sharedAccountId: string,
  member: SharedCopyMember,
): Promise<{ auth: JmapAuth; session: JmapSession } | null> {
  const log = deps.log ?? defaultLog;
  let resolved: MailSessionResult;
  try {
    resolved = await deps.getMailSession(member);
  } catch (error) {
    // A revoked or rotated credential surfaces here as the provider refusing
    // the session. Not this cycle's problem to fix: the next request the
    // member makes will tell them, and the next cycle re-checks.
    log("warn", "shared mailbox copy: member session unavailable", {
      sharedAccountId,
      userId: member.userId,
      error: String(error),
    });
    return null;
  }
  if (!resolved.ok) {
    log("info", "shared mailbox copy: member skipped", {
      sharedAccountId,
      userId: member.userId,
      reason: resolved.reason,
    });
    return null;
  }
  if (!reaches(resolved.session, sharedAccountId)) {
    // The opt-in outlived the membership: Stalwart no longer lists the account
    // in this member's session. Their preference row still names it, which is
    // harmless — GET /shared-accounts only tags accounts the session lists.
    log("info", "shared mailbox copy: member no longer reaches the account", {
      sharedAccountId,
      userId: member.userId,
    });
    return null;
  }
  return { auth: resolved.auth, session: resolved.session };
}

/**
 * The member whose credential reads the shared account this cycle: the first
 * opted-in member, in the order given, whose session reaches it. Exported for
 * ./watcher.ts, which needs the same election to open its push subscription.
 */
export async function electWatcher(
  deps: DeliveryDeps,
  input: { sharedAccountId: string; members: SharedCopyMember[] },
): Promise<ElectedWatcher | null> {
  for (const member of input.members) {
    const resolved = await resolveMember(deps, input.sharedAccountId, member);
    if (resolved) return { member, ...resolved };
  }
  return null;
}

/** The shared account's current Email state, from an `Email/get` with no ids. */
async function currentEmailState(watcher: ElectedWatcher, deps: DeliveryDeps, sharedAccountId: string) {
  const responses = await deps.jmap.request(watcher.auth, watcher.session, [
    ["Email/get", { accountId: sharedAccountId, ids: [], properties: ["id"] }, "state"],
  ]);
  const state = (responses[0]?.[1] as { state?: unknown } | undefined)?.state;
  if (typeof state !== "string" || state === "") {
    throw new Error(`shared mailbox copy: no Email state returned for account ${sharedAccountId}`);
  }
  return state;
}

async function baseline(
  deps: DeliveryDeps,
  watcher: ElectedWatcher,
  sharedAccountId: string,
  reason: "no_cursor" | "cannot_calculate_changes",
): Promise<DeliveryCycleResult> {
  const state = await currentEmailState(watcher, deps, sharedAccountId);
  await deps.copies.setCursor(sharedAccountId, state);
  (deps.log ?? defaultLog)(reason === "no_cursor" ? "info" : "warn", "shared mailbox copy: baselined", {
    sharedAccountId,
    reason,
    state,
  });
  return { status: "baselined", reason };
}

type ChangesPage = { newState: string; hasMoreChanges: boolean; created: string[] };

async function fetchChanges(
  deps: DeliveryDeps,
  watcher: ElectedWatcher,
  sharedAccountId: string,
  sinceState: string,
): Promise<ChangesPage> {
  const responses = await deps.jmap.request(watcher.auth, watcher.session, [
    [
      "Email/changes",
      { accountId: sharedAccountId, sinceState, maxChanges: DELIVERY_PAGE_SIZE },
      "ch",
    ],
  ]);
  const page = (responses[0]?.[1] ?? {}) as {
    newState?: unknown;
    hasMoreChanges?: unknown;
    created?: unknown;
  };
  if (typeof page.newState !== "string" || page.newState === "") {
    throw new Error(`shared mailbox copy: Email/changes returned no newState for ${sharedAccountId}`);
  }
  return {
    newState: page.newState,
    hasMoreChanges: page.hasMoreChanges === true,
    created: Array.isArray(page.created)
      ? page.created.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * Of the ids a page created, the ones sitting in the shared account's INBOX
 * — one read batch through the watcher. Mail the group sends, drafts, and
 * anything filed elsewhere by a Sieve rule is not "new mail in the shared
 * mailbox" and is not copied; the manual button remains for those.
 */
async function inboxOnly(
  deps: DeliveryDeps,
  watcher: ElectedWatcher,
  sharedAccountId: string,
  ids: string[],
): Promise<string[]> {
  const responses = await deps.jmap.request(watcher.auth, watcher.session, [
    ["Mailbox/query", { accountId: sharedAccountId, filter: { role: "inbox" } }, "mbx"],
    ["Email/get", { accountId: sharedAccountId, ids, properties: ["mailboxIds"] }, "src"],
  ]);
  const inboxId = ((responses[0]?.[1] ?? {}) as { ids?: string[] }).ids?.[0];
  if (!inboxId) {
    // Without the inbox nothing on the page can be classified. Failing the
    // cycle keeps the cursor where it is, so the page is retried rather than
    // skipped — a provider that momentarily cannot list mailboxes must not
    // cost anyone the mail that arrived meanwhile.
    throw new Error(`shared mailbox copy: cannot resolve the inbox of account ${sharedAccountId}`);
  }
  const list = ((responses[1]?.[1] ?? {}) as {
    list?: Array<{ id: string; mailboxIds?: Record<string, boolean> }>;
  }).list ?? [];
  return list.filter((email) => email.mailboxIds?.[inboxId] === true).map((email) => email.id);
}

async function deliverPage(
  deps: DeliveryDeps,
  sharedAccountId: string,
  members: SharedCopyMember[],
  emailIds: string[],
  counts: { copied: number; skipped: number; failed: number },
): Promise<void> {
  const log = deps.log ?? defaultLog;
  const report = deps.onCopyResult ?? recordSharedMailboxCopy;
  for (const member of members) {
    const resolved = await resolveMember(deps, sharedAccountId, member);
    if (!resolved) continue;
    const already = await deps.copies.hasCopies(member.userId, sharedAccountId, emailIds);
    for (const emailId of emailIds) {
      if (already.has(emailId)) {
        counts.skipped += 1;
        report("skipped");
        continue;
      }
      try {
        const result = await copyEmailToPersonalInbox({
          jmap: deps.jmap,
          auth: resolved.auth,
          session: resolved.session,
          fromAccountId: sharedAccountId,
          emailId,
        });
        if (result.ok) {
          await deps.copies.recordCopy(member.userId, sharedAccountId, emailId);
          counts.copied += 1;
          report("copied");
          continue;
        }
        counts.failed += 1;
        report("failed");
        log("warn", "shared mailbox copy: copy refused", {
          sharedAccountId,
          userId: member.userId,
          emailId,
          reason: result.reason,
        });
      } catch (error) {
        counts.failed += 1;
        report("failed");
        log("warn", "shared mailbox copy: copy failed", {
          sharedAccountId,
          userId: member.userId,
          emailId,
          error: String(error),
        });
      }
    }
  }
}

/**
 * Runs one cycle for `sharedAccountId` on behalf of `members` (every member
 * opted into it, as listed by userPreferences.listSharedMailboxCopyOptIns).
 *
 * Serialised per account twice over: in-process by the worker's single-flight
 * queue, and across replicas by the transaction-scoped advisory lock the repo
 * takes (`locked` when another holder has it). Subscriptions and polls MAY be
 * duplicated across replicas — each replica watches every account — but the
 * lock guarantees only one of them delivers a given page, and the ledger
 * guarantees a page replayed after a crash delivers nothing twice.
 */
export async function runDeliveryCycle(
  deps: DeliveryDeps,
  input: { sharedAccountId: string; members: SharedCopyMember[] },
): Promise<DeliveryCycleResult> {
  const { sharedAccountId, members } = input;
  const log = deps.log ?? defaultLog;

  const ran = await deps.copies.withAccountLock(sharedAccountId, async (): Promise<DeliveryCycleResult> => {
    const watcher = await electWatcher(deps, input);
    if (!watcher) {
      log("warn", "shared mailbox copy: no watcher for account", {
        sharedAccountId,
        members: members.length,
      });
      return { status: "no_watcher" };
    }

    let cursor = await deps.copies.getCursor(sharedAccountId);
    if (cursor === null) {
      return baseline(deps, watcher, sharedAccountId, "no_cursor");
    }

    const counts = { copied: 0, skipped: 0, failed: 0 };
    let pages = 0;
    let truncated = false;
    for (;;) {
      let page: ChangesPage;
      try {
        page = await fetchChanges(deps, watcher, sharedAccountId, cursor);
      } catch (error) {
        if (error instanceof JmapMethodError && error.methodErrorType === "cannotCalculateChanges") {
          return baseline(deps, watcher, sharedAccountId, "cannot_calculate_changes");
        }
        throw error;
      }
      pages += 1;

      if (page.created.length > 0) {
        const deliverable = await inboxOnly(deps, watcher, sharedAccountId, page.created);
        if (deliverable.length > 0) {
          await deliverPage(deps, sharedAccountId, members, deliverable, counts);
        }
      }
      // After the page's copies, never before: a crash in between replays the
      // page, and the ledger turns the replay into skips instead of doubles.
      await deps.copies.setCursor(sharedAccountId, page.newState);
      cursor = page.newState;

      if (!page.hasMoreChanges) break;
      if (pages >= DELIVERY_MAX_PAGES) {
        truncated = true;
        break;
      }
    }

    log(counts.copied + counts.failed > 0 ? "info" : "debug", "shared mailbox copy: cycle finished", {
      sharedAccountId,
      ...counts,
      pages,
      truncated,
    });
    return { status: "delivered", ...counts, pages, truncated };
  });

  return ran ?? { status: "locked" };
}
