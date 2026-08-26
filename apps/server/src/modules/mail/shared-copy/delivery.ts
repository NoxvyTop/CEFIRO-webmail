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
 * - another replica (or this one) holds the account's lease → `locked`,
 *   nothing touched;
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
 *   a page behind one member's failure would starve everyone else's mail;
 * - a copy claimed in the ledger but never confirmed (this process died, or
 *   the database failed, between the provider making the copy and the row
 *   being written) → `unresolved`: counted, logged once per member and page,
 *   and NEVER re-copied. Delivery is at-most-once by design, because a
 *   duplicated message is the failure a member notices and a missing one has
 *   an obvious recovery — their own manual copy-to-inbox button.
 */

import { log as defaultLog } from "../../../core/logger";
import { recordSharedMailboxCopy, type SharedMailboxCopyResult } from "../../../core/metrics";
import { JmapMethodError, type JmapAuth, type JmapClient, type JmapSession } from "../../../infra/jmap/client";
import type { SharedCopyStatus } from "../../../infra/repos/shared-mailbox-copies";
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

/**
 * How long a cycle's lease on an account is good for, renewed after every
 * page. Ten minutes: far longer than any healthy cycle (five pages of a
 * hundred messages), so a live cycle is never taken over mid-flight, and short
 * enough that an account whose holder was SIGKILLed is delivered again within
 * a couple of poll intervals rather than staying wedged. Nothing waits on it —
 * a cycle that finds the lease taken yields, because whoever holds it is doing
 * the same work.
 */
export const DELIVERY_LEASE_TTL_MS = 600_000;

/**
 * How many times a failed copy is re-attempted before the cycle gives up on
 * it. Five, spread over five cycles (25 minutes at the default poll), covers
 * the failures that pass on their own — a provider restart, a brief network
 * fault, a mailbox momentarily locked — while a copy that cannot succeed (the
 * source destroyed, a member permanently over quota) stops costing a JMAP call
 * every cycle for ever. The row stays behind as the record that it was not
 * delivered.
 */
export const DELIVERY_RETRY_MAX_ATTEMPTS = 5;

/**
 * How many failed copies one cycle re-attempts. Keeps the recovery work
 * proportional: a provider outage that failed thousands of copies is drained
 * over several cycles instead of stalling the first one behind a queue of
 * retries while new mail waits.
 */
export const DELIVERY_RETRY_LIMIT = 100;

/**
 * Identifies THIS process as a lease holder when no owner was injected. The
 * worker mints its own (see ./worker.ts) and passes it in; this fallback keeps
 * a directly-called cycle — a test, a one-off script — from having to.
 * Per-process, never per-cycle: the same process re-entering its own lease
 * must be allowed to, and a restarted process must not inherit the old one.
 */
const PROCESS_LEASE_OWNER = crypto.randomUUID();

/**
 * How old a cursor may be before the cycle re-baselines instead of resuming
 * from it (`SHARED_MAILBOX_COPY_STALE_MS`, in prose). TWO poll intervals: one
 * is the normal spacing between cycles, so two means "at least one whole cycle
 * did not happen" — the worker was off, the deployment was down, or nobody
 * opted into this account — while still tolerating a poll that ran late.
 *
 * Derived from SHARED_MAILBOX_COPY_POLL_MS rather than configured on its own
 * (./worker.ts passes it in): an operator who lengthens the poll means the
 * cycles to be further apart, and a fixed staleness window would start calling
 * every one of their normal resumes a backlog.
 *
 * This constant is the fallback for a cycle called with no `staleMs` — two of
 * the DEFAULT five-minute poll intervals.
 */
export const DELIVERY_STALE_POLL_INTERVALS = 2;
export const DEFAULT_DELIVERY_STALE_MS = 600_000;

/** The stale window for a worker polling every `pollMs`. */
export function staleMsForPoll(pollMs: number): number {
  return pollMs * DELIVERY_STALE_POLL_INTERVALS;
}

export type SharedCopyMember = { userId: string; email: string };

type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

/** The slice of infra/repos/shared-mailbox-copies.ts the cycle uses. */
export type SharedCopyStore = {
  getState(
    sharedAccountId: string,
  ): Promise<{ emailState: string | null; lastCycleAt: Date | null }>;
  setCursor(sharedAccountId: string, emailState: string): Promise<void>;
  /**
   * Records the members this account had not seen before at `baselinedState`,
   * forgets the ones no longer listed, and answers with the newly recorded
   * ids — the members this cycle must NOT deliver to.
   */
  baselineMembers(
    sharedAccountId: string,
    userIds: string[],
    baselinedState: string,
  ): Promise<string[]>;
  /** Ledger status of the ids this member has a row for, one query per page. */
  copyStates(
    userId: string,
    sharedAccountId: string,
    emailIds: string[],
  ): Promise<Map<string, SharedCopyStatus>>;
  /** Claims the copy as `pending`, before the Email/copy is issued. */
  beginCopy(userId: string, sharedAccountId: string, emailId: string): Promise<void>;
  /** Confirms a copy the provider acknowledged. */
  markCopied(userId: string, sharedAccountId: string, emailId: string): Promise<void>;
  /** Marks a refused or thrown copy `failed`, counting the attempt. */
  markFailed(
    userId: string,
    sharedAccountId: string,
    emailId: string,
    lastError: string,
  ): Promise<void>;
  /** This account's failed copies still worth another try, oldest first. */
  listRetryable(
    sharedAccountId: string,
    options: { maxAttempts: number; limit: number },
  ): Promise<Array<{ userId: string; emailId: string; attempts: number }>>;
  acquireLease(sharedAccountId: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease(sharedAccountId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(sharedAccountId: string, owner: string): Promise<void>;
};

export type DeliveryDeps = {
  jmap: JmapClient;
  copies: SharedCopyStore;
  /** ../context.ts getMailSession, bound to its deps. */
  getMailSession(member: SharedCopyMember): Promise<MailSessionResult>;
  /**
   * Who this process is when it takes an account's delivery lease. Injected by
   * ./worker.ts, which mints one id per process; defaults to this module's own
   * per-process id.
   */
  leaseOwner?: string;
  /**
   * How old this account's cursor may be before the cycle re-baselines instead
   * of resuming from it. Injected by ./worker.ts as two poll intervals;
   * defaults to DEFAULT_DELIVERY_STALE_MS.
   */
  staleMs?: number;
  log?: LogFn;
  /**
   * Observed once per attempted copy. Defaults to the `/metrics` facade
   * (core/metrics.ts recordSharedMailboxCopy), which is a no-op until an app
   * registers a registry — so a unit test records into nowhere unless it
   * injects its own.
   */
  onCopyResult?(result: SharedMailboxCopyResult): void;
};

/**
 * Why a cycle recorded the current state instead of delivering:
 * - `no_cursor`: this account has never been followed;
 * - `stale_cursor`: no cycle has run for this account in `staleMs` — the
 *   worker was off, or nobody opted in — so what sits behind the cursor is a
 *   backlog, not a gap worth replaying into everyone's inbox;
 * - `cannot_calculate_changes`: the provider no longer has history that far
 *   back.
 */
export type BaselineReason = "no_cursor" | "stale_cursor" | "cannot_calculate_changes";

export type ElectedWatcher = {
  member: SharedCopyMember;
  auth: JmapAuth;
  session: JmapSession;
};

export type DeliveryCycleResult =
  | { status: "no_watcher" }
  | { status: "locked" }
  | { status: "baselined"; reason: BaselineReason }
  | ({
      status: "delivered";
      pages: number;
      /** True when the page cap stopped the cycle with changes still pending. */
      truncated: boolean;
    } & DeliveryCounts);

/**
 * What one cycle did, per attempted copy. `unresolved` counts ledger rows an
 * earlier attempt claimed and never confirmed: they are left exactly as they
 * are, because re-copying one risks the duplicate this design refuses.
 */
export type DeliveryCounts = {
  copied: number;
  skipped: number;
  failed: number;
  unresolved: number;
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
  members: SharedCopyMember[],
  reason: BaselineReason,
): Promise<DeliveryCycleResult> {
  const state = await currentEmailState(watcher, deps, sharedAccountId);
  await deps.copies.setCursor(sharedAccountId, state);
  // The members are baselined at the same state the account is: a cycle that
  // copies nothing must still leave every member "seen from here", or the
  // next cycle would baseline them all over again and delay their first copy
  // by another interval.
  await deps.copies.baselineMembers(
    sharedAccountId,
    members.map((member) => member.userId),
    state,
  );
  (deps.log ?? defaultLog)(reason === "no_cursor" ? "info" : "warn", "shared mailbox copy: baselined", {
    sharedAccountId,
    reason,
    state,
    members: members.length,
  });
  return { status: "baselined", reason };
}

type ChangesPage = { newState: string; hasMoreChanges: boolean; created: string[] };

/** A message of the page that is deliverable, with what the copy needs of it. */
type DeliverableEmail = { id: string; keywords: Record<string, boolean> };

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
): Promise<DeliverableEmail[]> {
  const responses = await deps.jmap.request(watcher.auth, watcher.session, [
    ["Mailbox/query", { accountId: sharedAccountId, filter: { role: "inbox" } }, "mbx"],
    // `keywords` rides along with the `mailboxIds` this read needs anyway, so
    // each copy carries the source's flags without a read of its own. Without
    // it, every (member, message) pair paid a round trip to fetch keywords
    // that are identical for all of them.
    [
      "Email/get",
      { accountId: sharedAccountId, ids, properties: ["mailboxIds", "keywords"] },
      "src",
    ],
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
    list?: Array<{
      id: string;
      mailboxIds?: Record<string, boolean>;
      keywords?: Record<string, boolean>;
    }>;
  }).list ?? [];
  return list
    .filter((email) => email.mailboxIds?.[inboxId] === true)
    .map((email) => ({ id: email.id, keywords: email.keywords ?? {} }));
}

/**
 * The member's personal Inbox id, resolved ONCE per member per cycle and kept
 * in `inboxes`. It is the same id for every message on every page, so asking
 * per copy was a round trip per (member, message) for an answer that cannot
 * change mid-cycle.
 *
 * `null` means the provider could not name it; the copy then falls back to the
 * lookup path inside ./copy.ts, which answers `mailbox_roles_missing` exactly
 * as it always did rather than the cycle inventing a new failure of its own.
 */
async function personalInboxOf(
  deps: DeliveryDeps,
  member: SharedCopyMember,
  resolved: { auth: JmapAuth; session: JmapSession },
  inboxes: Map<string, string | null>,
): Promise<string | null> {
  const cached = inboxes.get(member.userId);
  if (cached !== undefined) return cached;
  let inboxId: string | null = null;
  try {
    const responses = await deps.jmap.request(resolved.auth, resolved.session, [
      [
        "Mailbox/query",
        { accountId: resolved.session.accountId, filter: { role: "inbox" } },
        "mbx",
      ],
    ]);
    inboxId = ((responses[0]?.[1] ?? {}) as { ids?: string[] }).ids?.[0] ?? null;
  } catch (error) {
    // Not fatal here: the per-copy lookup will hit the same provider and
    // produce the failure — counted, logged and retried — that this cycle
    // would otherwise have to duplicate.
    (deps.log ?? defaultLog)("warn", "shared mailbox copy: personal inbox lookup failed", {
      userId: member.userId,
      error: String(error),
    });
  }
  inboxes.set(member.userId, inboxId);
  return inboxId;
}

/**
 * One member's copy of one message, ledger and all. Returns nothing: every
 * outcome is counted and reported here, because "what happened to this copy"
 * has exactly one place to be decided.
 */
async function copyOne(
  deps: DeliveryDeps,
  sharedAccountId: string,
  member: SharedCopyMember,
  resolved: { auth: JmapAuth; session: JmapSession },
  emailId: string,
  counts: DeliveryCounts,
  /**
   * What the cycle already knows about this copy: the member's inbox (resolved
   * once per cycle) and the source's keywords (read with the page). Absent on
   * the retry pass, which works from ledger rows rather than a page and lets
   * ./copy.ts look both up.
   */
  known?: { personalInboxId: string; keywords: Record<string, boolean> },
): Promise<void> {
  const log = deps.log ?? defaultLog;
  const report = deps.onCopyResult ?? recordSharedMailboxCopy;

  // Claimed BEFORE the copy: between a confirmed Email/copy and the row that
  // records it there is a window, and a crash inside it used to replay the
  // copy on the next cycle and deliver the message twice. A claim that
  // survives without a confirmation is read as "may have been copied" and
  // never copied again.
  await deps.copies.beginCopy(member.userId, sharedAccountId, emailId);
  try {
    const result = await copyEmailToPersonalInbox({
      jmap: deps.jmap,
      auth: resolved.auth,
      session: resolved.session,
      fromAccountId: sharedAccountId,
      emailId,
      ...known,
    });
    if (result.ok) {
      try {
        await deps.copies.markCopied(member.userId, sharedAccountId, emailId);
      } catch (error) {
        // The copy IS made — the provider confirmed it — so it counts as
        // copied and the cycle carries on. The row stays `pending`, which is
        // what keeps the next cycle from making it a second time.
        log("error", "shared mailbox copy: ledger confirmation failed after a made copy", {
          sharedAccountId,
          userId: member.userId,
          emailId,
          error: String(error),
        });
      }
      counts.copied += 1;
      report("copied");
      return;
    }
    await recordFailure(deps, sharedAccountId, member, emailId, result.reason, counts);
    log("warn", "shared mailbox copy: copy refused", {
      sharedAccountId,
      userId: member.userId,
      emailId,
      reason: result.reason,
    });
  } catch (error) {
    await recordFailure(deps, sharedAccountId, member, emailId, String(error), counts);
    log("warn", "shared mailbox copy: copy failed", {
      sharedAccountId,
      userId: member.userId,
      emailId,
      error: String(error),
    });
  }
}

/**
 * Turns the claimed row into a `failed` one, so the next cycle's retry pass
 * can pick it up. A failure that only ever reached the log cost the member
 * that message for good: the cursor advances past the page regardless, and
 * nothing else remembers the attempt.
 */
async function recordFailure(
  deps: DeliveryDeps,
  sharedAccountId: string,
  member: SharedCopyMember,
  emailId: string,
  reason: string,
  counts: DeliveryCounts,
): Promise<void> {
  counts.failed += 1;
  (deps.onCopyResult ?? recordSharedMailboxCopy)("failed");
  try {
    await deps.copies.markFailed(member.userId, sharedAccountId, emailId, reason);
  } catch (error) {
    // The row stays `pending`, which the next cycle reads as unresolved and
    // leaves alone. Worse than a retry, better than a duplicate — and this is
    // a database that is already failing, which the cycle cannot fix.
    (deps.log ?? defaultLog)("error", "shared mailbox copy: could not record the failure", {
      sharedAccountId,
      userId: member.userId,
      emailId,
      error: String(error),
    });
  }
}

/**
 * Re-attempts a bounded batch of this account's failed copies, before the
 * cycle looks at new pages: a transient provider failure must not cost a
 * member their message, and the cursor has already moved past the page that
 * carried it.
 *
 * Only members this cycle is delivering to are retried — someone who opted
 * out, or whom this cycle only just baselined, is left exactly as they are —
 * and each retry goes through the same copy path as a fresh one, ledger
 * included, so a retry that succeeds is a confirmed copy and one that fails
 * again just spends another attempt.
 */
async function retryFailed(
  deps: DeliveryDeps,
  sharedAccountId: string,
  members: SharedCopyMember[],
  counts: DeliveryCounts,
): Promise<void> {
  if (members.length === 0) return;
  const log = deps.log ?? defaultLog;
  const retryable = await deps.copies.listRetryable(sharedAccountId, {
    maxAttempts: DELIVERY_RETRY_MAX_ATTEMPTS,
    limit: DELIVERY_RETRY_LIMIT,
  });
  if (retryable.length === 0) return;

  const byMember = new Map<string, string[]>();
  for (const row of retryable) {
    byMember.set(row.userId, [...(byMember.get(row.userId) ?? []), row.emailId]);
  }
  for (const member of members) {
    const emailIds = byMember.get(member.userId);
    if (!emailIds || emailIds.length === 0) continue;
    const resolved = await resolveMember(deps, sharedAccountId, member);
    if (!resolved) continue;
    log("info", "shared mailbox copy: retrying failed copies", {
      sharedAccountId,
      userId: member.userId,
      emailIds: emailIds.length,
    });
    for (const emailId of emailIds) {
      await copyOne(deps, sharedAccountId, member, resolved, emailId, counts);
    }
  }
}

async function deliverPage(
  deps: DeliveryDeps,
  sharedAccountId: string,
  members: SharedCopyMember[],
  emails: DeliverableEmail[],
  counts: DeliveryCounts,
  inboxes: Map<string, string | null>,
): Promise<void> {
  const log = deps.log ?? defaultLog;
  const report = deps.onCopyResult ?? recordSharedMailboxCopy;
  const emailIds = emails.map((email) => email.id);
  for (const member of members) {
    const resolved = await resolveMember(deps, sharedAccountId, member);
    if (!resolved) continue;
    const states = await deps.copies.copyStates(member.userId, sharedAccountId, emailIds);
    const unresolved: string[] = [];
    let personalInboxId: string | null | undefined;
    for (const email of emails) {
      const state = states.get(email.id);
      if (state === "copied") {
        counts.skipped += 1;
        report("skipped");
        continue;
      }
      if (state === "pending") {
        // Claimed by an earlier attempt that never confirmed. It may already
        // be in the member's inbox, so copying it again risks a duplicate —
        // the one outcome this design refuses. At most once, deliberately.
        counts.unresolved += 1;
        report("unresolved");
        unresolved.push(email.id);
        continue;
      }
      // Resolved lazily and at most once per cycle: a member with nothing to
      // receive never costs the lookup at all.
      if (personalInboxId === undefined) {
        personalInboxId = await personalInboxOf(deps, member, resolved, inboxes);
      }
      await copyOne(
        deps,
        sharedAccountId,
        member,
        resolved,
        email.id,
        counts,
        personalInboxId === null
          ? undefined
          : { personalInboxId, keywords: email.keywords },
      );
    }
    if (unresolved.length > 0) {
      // One line per member and page rather than per message: the operator
      // needs to know it happened and to whom, not to read it N times.
      log("warn", "shared mailbox copy: unresolved copies left as they are", {
        sharedAccountId,
        userId: member.userId,
        emailIds: unresolved,
        recovery: "the member's manual copy-to-inbox button",
      });
    }
  }
}

/** The cycle proper, with this account's lease already held by `owner`. */
async function deliver(
  deps: DeliveryDeps,
  input: { sharedAccountId: string; members: SharedCopyMember[] },
  owner: string,
): Promise<DeliveryCycleResult> {
  const { sharedAccountId, members } = input;
  const log = deps.log ?? defaultLog;

  const watcher = await electWatcher(deps, input);
  if (!watcher) {
    log("warn", "shared mailbox copy: no watcher for account", {
      sharedAccountId,
      members: members.length,
    });
    return { status: "no_watcher" };
  }

  const state = await deps.copies.getState(sharedAccountId);
  if (state.emailState === null) {
    return baseline(deps, watcher, sharedAccountId, members, "no_cursor");
  }
  // A cursor nothing has moved in `staleMs` does not describe a gap worth
  // replaying: it points at everything that arrived while the worker was off,
  // or while this account had nobody to deliver to. Copying all of it at once
  // is the failure this guard exists for; the manual button still reaches it.
  const staleMs = deps.staleMs ?? DEFAULT_DELIVERY_STALE_MS;
  const cursorAgeMs = state.lastCycleAt === null ? Infinity : Date.now() - state.lastCycleAt.getTime();
  if (cursorAgeMs > staleMs) {
    log("warn", "shared mailbox copy: cursor went stale, re-baselining", {
      sharedAccountId,
      staleMs,
      cursorAgeMs: Number.isFinite(cursorAgeMs) ? cursorAgeMs : null,
    });
    return baseline(deps, watcher, sharedAccountId, members, "stale_cursor");
  }
  let cursor = state.emailState;

  // Members this account had never seen are recorded at the state this cycle
  // starts from and served from the NEXT one: an opt-in is forward-looking,
  // and delivering to a member who joined mid-cycle would hand them every
  // message the account has seen since it was first baselined.
  const joining = new Set(
    await deps.copies.baselineMembers(
      sharedAccountId,
      members.map((member) => member.userId),
      cursor,
    ),
  );
  const deliverTo = members.filter((member) => !joining.has(member.userId));
  if (joining.size > 0) {
    log("info", "shared mailbox copy: members baselined, deliverable next cycle", {
      sharedAccountId,
      baselined: joining.size,
      state: cursor,
    });
  }

  const counts: DeliveryCounts = { copied: 0, skipped: 0, failed: 0, unresolved: 0 };
  // One personal-inbox lookup per member for the whole cycle, pages included.
  const inboxes = new Map<string, string | null>();

  // Before any new page: the copies an earlier cycle could not make. The
  // cursor has already moved past the pages that carried them, so this pass is
  // the only thing that still can deliver them — and doing it first keeps a
  // transient failure from ageing out behind a busy mailbox.
  await retryFailed(deps, sharedAccountId, deliverTo, counts);

  let pages = 0;
  let truncated = false;
  for (;;) {
    let page: ChangesPage;
    try {
      page = await fetchChanges(deps, watcher, sharedAccountId, cursor);
    } catch (error) {
      if (error instanceof JmapMethodError && error.methodErrorType === "cannotCalculateChanges") {
        return baseline(deps, watcher, sharedAccountId, members, "cannot_calculate_changes");
      }
      throw error;
    }
    pages += 1;

    if (page.created.length > 0 && deliverTo.length > 0) {
      const deliverable = await inboxOnly(deps, watcher, sharedAccountId, page.created);
      if (deliverable.length > 0) {
        await deliverPage(deps, sharedAccountId, deliverTo, deliverable, counts, inboxes);
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
    // Pushed out page by page rather than taken for the whole cycle at once:
    // the TTL that survives a long burst is the same TTL that has to expire
    // before a killed holder's account is delivered again, and renewing keeps
    // those two apart. Losing it means another replica already took the
    // account over, so this cycle stops rather than delivering the same pages
    // alongside it.
    if (!(await deps.copies.renewLease(sharedAccountId, owner, DELIVERY_LEASE_TTL_MS))) {
      log("warn", "shared mailbox copy: lease lost mid-cycle", { sharedAccountId, pages });
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
}

/**
 * Runs one cycle for `sharedAccountId` on behalf of `members` (every member
 * opted into it, as listed by userPreferences.listSharedMailboxCopyOptIns).
 *
 * Serialised per account twice over: in-process by the worker's single-flight
 * queue, and across replicas by the account's delivery LEASE (`locked` when
 * another holder has it). Subscriptions and polls MAY be duplicated across
 * replicas — each replica watches every account — but the lease guarantees
 * only one of them delivers a given page, and the ledger guarantees a page
 * replayed after a crash delivers nothing twice.
 *
 * The lease is a row, taken and released with ordinary statements, and NO
 * transaction spans the cycle: the advisory lock it replaced held a pooled
 * connection open in a transaction for the whole cycle while every query of
 * that cycle asked the same pool for another connection — which deadlocks
 * outright at DB_POOL_MAX=1 and leaves a minutes-long idle-in-transaction
 * connection otherwise.
 */
export async function runDeliveryCycle(
  deps: DeliveryDeps,
  input: { sharedAccountId: string; members: SharedCopyMember[] },
): Promise<DeliveryCycleResult> {
  const { sharedAccountId } = input;
  const log = deps.log ?? defaultLog;
  const owner = deps.leaseOwner ?? PROCESS_LEASE_OWNER;

  const leased = await deps.copies.acquireLease(sharedAccountId, owner, DELIVERY_LEASE_TTL_MS);
  if (!leased) return { status: "locked" };

  try {
    return await deliver(deps, input, owner);
  } finally {
    // Best effort, and deliberately not allowed to mask the cycle's own
    // outcome: an unreleased lease costs at most one TTL of latency, while a
    // release that threw over the real error would cost the diagnosis.
    try {
      await deps.copies.releaseLease(sharedAccountId, owner);
    } catch (error) {
      log("warn", "shared mailbox copy: lease release failed", {
        sharedAccountId,
        error: String(error),
      });
    }
  }
}
