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
 * - the lease is lost DURING a cycle (a renewal refused because another
 *   replica took the account over) → the cycle stops copying at once and
 *   leaves the page's cursor where it is, so the new holder re-reads that page
 *   and the ledger turns what was already copied into skips;
 * - no cursor → record the current state, copy NOTHING (`baselined`): the
 *   opt-in is forward-looking, and historic mail stays reachable through the
 *   manual copy;
 * - a member the account had not seen before → recorded as baselined NOW and
 *   served from this very cycle, but only with the messages the shared mailbox
 *   received from that moment on (`receivedAt >= baselined_at`, less a clock
 *   skew margin — see DELIVERY_BASELINE_SKEW_MS). The backlog behind the
 *   cursor, however many cycles it takes to drain, is never theirs;
 * - a cursor left behind by a cycle that ran hours or days ago → resumed like
 *   any other. Time is NOT evidence: an outage, a deploy, an account nobody
 *   could watch and a cycle whose error was swallowed are indistinguishable
 *   from a pause, and the age-based re-baseline this replaces dropped every
 *   message of the gap. A gap DEFERS delivery (the backlog drains at
 *   DELIVERY_MAX_PAGES pages a cycle), it never cancels it;
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
 * member's batch and between pages. Ten minutes: far longer than any healthy
 * cycle (five pages of a hundred messages), so a live cycle is never taken
 * over mid-flight, and short enough that an account whose holder was SIGKILLed
 * is delivered again within a couple of poll intervals rather than staying
 * wedged. Nothing waits on it — a cycle that finds the lease taken yields,
 * because whoever holds it is doing the same work.
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
 * How far BEFORE a member's baseline a message may have been received and
 * still be theirs. The provider stamps `receivedAt` with its clock and this
 * server's database stamps `baselined_at` with its own; a provider running a
 * few seconds behind would otherwise withhold the very message that arrived
 * right after the opt-in, which is the message the member switched the option
 * on for. The trade is deliberate and bounded: a message received within that
 * minute BEFORE the opt-in is copied too, and a minute of somebody else's mail
 * is nothing like the months a back-fill would hand over.
 */
export const DELIVERY_BASELINE_SKEW_MS = 60_000;

/**
 * Identifies THIS process as a lease holder when no owner was injected. The
 * worker mints its own (see ./worker.ts) and passes it in; this fallback keeps
 * a directly-called cycle — a test, a one-off script — from having to.
 * Per-process, never per-cycle: the same process re-entering its own lease
 * must be allowed to, and a restarted process must not inherit the old one.
 */
const PROCESS_LEASE_OWNER = crypto.randomUUID();

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
  /**
   * Stamps "a cycle was attempted for this account, now". Informational only —
   * nothing decides anything from it — so it is written as soon as the lease
   * is taken rather than on a successful advance.
   */
  markCycleAttempt(sharedAccountId: string): Promise<void>;
  setCursor(sharedAccountId: string, emailState: string): Promise<void>;
  /** Shared accounts this deployment holds any state for (./worker.ts). */
  listAccountIds(): Promise<string[]>;
  /**
   * Forgets the members this account no longer has, along with their open
   * ledger rows. Called by the cycle through `baselineMembers` and, for the
   * accounts no cycle runs for any more, by ./worker.ts directly.
   */
  pruneMembers(sharedAccountId: string, userIds: string[]): Promise<void>;
  /**
   * Records the members this account had not seen before as baselined NOW,
   * forgets the ones no longer listed, and answers with every listed member's
   * baseline — the moment from which each is entitled to copies.
   */
  baselineMembers(sharedAccountId: string, userIds: string[]): Promise<Map<string, Date>>;
  /** Ledger status of the ids this member has a row for, one query per page. */
  copyStates(
    userId: string,
    sharedAccountId: string,
    emailIds: string[],
  ): Promise<Map<string, SharedCopyStatus>>;
  /**
   * Claims the copy as `pending`, before the Email/copy is issued, recording
   * the source's Message-ID and receivedAt when the caller read them — the
   * first is what a later retry checks against the member's inbox, the second
   * what it places against the member's baseline.
   */
  beginCopy(
    userId: string,
    sharedAccountId: string,
    emailId: string,
    messageId?: string | null,
    receivedAt?: Date | null,
  ): Promise<void>;
  /** Confirms a copy the provider acknowledged. */
  markCopied(userId: string, sharedAccountId: string, emailId: string): Promise<void>;
  /** Marks a refused or thrown copy `failed`, counting the attempt. */
  markFailed(
    userId: string,
    sharedAccountId: string,
    emailId: string,
    lastError: string,
  ): Promise<void>;
  /**
   * This account's failed copies still worth another try, oldest first,
   * restricted to the members this cycle can deliver to.
   */
  listRetryable(
    sharedAccountId: string,
    options: { userIds: string[]; maxAttempts: number; limit: number },
  ): Promise<
    Array<{
      userId: string;
      emailId: string;
      attempts: number;
      messageId: string | null;
      receivedAt: Date | null;
    }>
  >;
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
 * - `cannot_calculate_changes`: the provider no longer has history that far
 *   back.
 *
 * There is deliberately no time-based reason. A cursor that has not moved in
 * hours is not evidence of anything: the worker may have been off, the
 * provider unreachable, the account without a watcher, or a cycle may simply
 * have failed and been swallowed. Re-baselining on that guess dropped every
 * message of the gap, so a cycle always resumes from the cursor and the
 * per-member baseline is the only rule that keeps an opt-in from back-filling.
 */
export type BaselineReason = "no_cursor" | "cannot_calculate_changes";

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
  // The members are baselined alongside the account: a cycle that copies
  // nothing must still leave every member "entitled from here", so the mail
  // arriving from this moment on is theirs on the next cycle.
  await deps.copies.baselineMembers(
    sharedAccountId,
    members.map((member) => member.userId),
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

/**
 * A message of the page that is deliverable, with what the copy needs of it:
 * its keywords (carried into the copy), its RFC 5322 Message-ID (recorded
 * with the claim, so a retry can ask whether the copy already exists — null
 * when the source has no Message-ID header, rare but legal) and when the
 * shared mailbox received it (what each member's baseline is compared with).
 */
type DeliverableEmail = {
  id: string;
  keywords: Record<string, boolean>;
  messageId: string | null;
  receivedAt: Date;
};

/**
 * Whether a message received at `receivedAt` is OLDER than what a member
 * baselined at `baselinedAt` is entitled to — the one rule that keeps an
 * opt-in from back-filling, applied to pages and retries alike.
 */
function predatesBaseline(receivedAt: Date, baselinedAt: Date): boolean {
  return receivedAt.getTime() < baselinedAt.getTime() - DELIVERY_BASELINE_SKEW_MS;
}

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
  /** Once per cycle, not per page: whether the provider was already reported for it. */
  warned: { noMessageId: boolean },
): Promise<DeliverableEmail[]> {
  const responses = await deps.jmap.request(
    watcher.auth,
    watcher.session,
    [
      ["Mailbox/query", { accountId: sharedAccountId, filter: { role: "inbox" } }, "mbx"],
      // `keywords`, `messageId` and `receivedAt` ride along with the
      // `mailboxIds` this read needs anyway: the first carries the source's
      // flags into each copy, the second is recorded with the claim so a retry
      // can ask whether the copy already exists, the third is what every
      // member's baseline is compared with. Without them, every (member,
      // message) pair paid a round trip for answers identical for all of them.
      [
        "Email/get",
        {
          accountId: sharedAccountId,
          ids,
          properties: ["mailboxIds", "keywords", "messageId", "receivedAt"],
        },
        "src",
      ],
    ],
    [],
    // `messageId` is one of the client's degradable properties, and its latch
    // is per process: once any conversation view had tripped it, this read
    // was silently stripped of `messageId` too, every claim stored null, and
    // the retry verification was disabled for the rest of the process with
    // nothing in the log. Isolated, the read asks for exactly what it needs
    // and an absent answer means THIS provider does not return it.
    { degradation: "isolated" },
  );
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
      /**
       * RFC 8621 §4.1.1: the header's value is a LIST of ids, `null` when the
       * message has no Message-ID header. ABSENT (undefined) is different: the
       * provider does not return the property at all.
       */
      messageId?: string[] | null;
      /** RFC 8621 §4.1.1 UTCDate, server-set and mandatory. */
      receivedAt?: unknown;
    }>;
  }).list ?? [];
  const deliverable = list.filter((email) => email.mailboxIds?.[inboxId] === true);
  const receivedAts = new Map<string, Date>();
  for (const email of deliverable) {
    const receivedAt =
      typeof email.receivedAt === "string" ? new Date(email.receivedAt) : new Date(Number.NaN);
    if (Number.isNaN(receivedAt.getTime())) {
      // Without it no message on the page can be placed against any member's
      // baseline, and guessing either way is wrong: delivering would hand a
      // joiner the backlog, withholding would lose the mail for everybody.
      // Like an unresolvable inbox, this fails the cycle and keeps the cursor,
      // so the page is retried rather than skipped.
      throw new Error(
        `shared mailbox copy: Email/get returned no receivedAt for ${email.id} in account ${sharedAccountId}`,
      );
    }
    receivedAts.set(email.id, receivedAt);
  }
  if (!warned.noMessageId && deliverable.some((email) => email.messageId === undefined)) {
    // Absent, not null: the provider refused or ignored the property. Every
    // claim of this cycle records no Message-ID, so a retry of any of them
    // cannot be verified against the member's inbox first. Said once per
    // cycle — the operator needs to know it is this provider, not read it per
    // page.
    warned.noMessageId = true;
    (deps.log ?? defaultLog)("warn", "shared mailbox copy: provider does not return messageId; retry verification disabled", {
      sharedAccountId,
    });
  }
  return deliverable.map((email) => ({
    id: email.id,
    keywords: email.keywords ?? {},
    messageId: email.messageId?.[0] ?? null,
    receivedAt: receivedAts.get(email.id)!,
  }));
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
   * The source's RFC 5322 Message-ID and receivedAt, read with the page and
   * recorded on the claim so a retry can ask whether this copy already exists
   * and place it against the member's baseline. Null when the source has no
   * Message-ID, and both null on the retry pass — which has the row's own
   * values already and must not overwrite them.
   */
  messageId: string | null,
  receivedAt: Date | null,
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
  await deps.copies.beginCopy(member.userId, sharedAccountId, emailId, messageId, receivedAt);
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
 * Pushes this account's lease out by another TTL, answering whether the cycle
 * still holds it. False means another replica took the account over and this
 * cycle must copy nothing more: it is called after every member's batch, not
 * only between pages, because a page longer than the TTL used to let a second
 * holder start copying the very same messages — the ledger is read once per
 * member per page, so neither cycle could see the other's claims in time.
 */
async function renewLeaseOrLose(
  deps: DeliveryDeps,
  sharedAccountId: string,
  owner: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  if (await deps.copies.renewLease(sharedAccountId, owner, DELIVERY_LEASE_TTL_MS)) return true;
  (deps.log ?? defaultLog)("warn", "shared mailbox copy: lease lost mid-cycle", {
    sharedAccountId,
    ...fields,
  });
  return false;
}

/**
 * Re-attempts a bounded batch of this account's failed copies, before the
 * cycle looks at new pages: a transient provider failure must not cost a
 * member their message, and the cursor has already moved past the page that
 * carried it.
 *
 * Only members this cycle is delivering to are retried — someone who opted
 * out is left exactly as they are — and each retry goes through the same copy
 * path as a fresh one, ledger included, so a retry that succeeds is a
 * confirmed copy and one that fails again just spends another attempt.
 *
 * The restriction is pushed into the QUERY, not applied to its answer: the
 * batch is the oldest hundred failed rows of the account, so rows nobody can
 * deliver used to fill it and starve the members being served.
 *
 * The member baseline rule applies here exactly as on a page: a row whose
 * source predates the member's baseline (a re-joiner's leftover, or a row
 * written by hand) is not delivered and spends an attempt instead, so it ages
 * out rather than holding the head of the batch.
 *
 * Every retry that CAN be verified is verified first (see `alreadyCopied`): a
 * copy the provider committed and then failed to acknowledge is recorded
 * `failed`, and re-copying it is the duplicate this design refuses.
 */
async function retryFailed(
  deps: DeliveryDeps,
  sharedAccountId: string,
  members: SharedCopyMember[],
  baselines: Map<string, Date>,
  counts: DeliveryCounts,
  owner: string,
  inboxes: Map<string, string | null>,
): Promise<boolean> {
  if (members.length === 0) return true;
  const log = deps.log ?? defaultLog;
  const report = deps.onCopyResult ?? recordSharedMailboxCopy;
  const retryable = await deps.copies.listRetryable(sharedAccountId, {
    userIds: members.map((member) => member.userId),
    maxAttempts: DELIVERY_RETRY_MAX_ATTEMPTS,
    limit: DELIVERY_RETRY_LIMIT,
  });
  if (retryable.length === 0) return true;

  type RetryRow = { emailId: string; messageId: string | null; receivedAt: Date | null };
  const byMember = new Map<string, RetryRow[]>();
  for (const row of retryable) {
    byMember.set(row.userId, [
      ...(byMember.get(row.userId) ?? []),
      { emailId: row.emailId, messageId: row.messageId, receivedAt: row.receivedAt },
    ]);
  }
  for (const member of members) {
    const rows = byMember.get(member.userId);
    if (!rows || rows.length === 0) continue;
    const resolved = await resolveMember(deps, sharedAccountId, member);
    if (!resolved) continue;
    log("info", "shared mailbox copy: retrying failed copies", {
      sharedAccountId,
      userId: member.userId,
      emailIds: rows.length,
    });
    const baselinedAt = baselineOf(baselines, member);
    for (const row of rows) {
      if (row.receivedAt && predatesBaseline(row.receivedAt, baselinedAt)) {
        await recordFailure(
          deps,
          sharedAccountId,
          member,
          row.emailId,
          "predates the member's opt-in baseline",
          counts,
        );
        continue;
      }
      const verdict = await alreadyCopied(deps, member, resolved, row.messageId, inboxes);
      if (verdict === "unknown") {
        // The provider could not answer, so nothing is known about whether the
        // copy exists. Copying blind is the one move that cannot be taken back;
        // the row keeps its attempt count and the next cycle asks again.
        continue;
      }
      if (verdict === "present") {
        counts.skipped += 1;
        report("skipped");
        try {
          await deps.copies.markCopied(member.userId, sharedAccountId, row.emailId);
        } catch (error) {
          // The copy is there either way; the row stays `failed` and the next
          // cycle reaches the same conclusion for the cost of one query.
          log("error", "shared mailbox copy: could not confirm a copy found in the inbox", {
            sharedAccountId,
            userId: member.userId,
            emailId: row.emailId,
            error: String(error),
          });
        }
        continue;
      }
      await copyOne(deps, sharedAccountId, member, resolved, row.emailId, counts, null, null);
    }
    if (!(await renewLeaseOrLose(deps, sharedAccountId, owner, { userId: member.userId }))) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the member's personal inbox ALREADY holds a copy of the source
 * message, found by the RFC 5322 Message-ID recorded with the claim.
 *
 * This exists for one failure only: an `Email/copy` whose response was lost
 * after the provider had committed it. That is recorded `failed`, exactly like
 * a copy that never happened, and retrying it delivered the message twice.
 *
 * Three answers, and each drives a different move:
 * - `present` → confirm the row, copy nothing;
 * - `absent` → copy, which is what the retry is for;
 * - `unknown` → the question could not be asked (no Message-ID on the source,
 *   no personal inbox, or the query failed), so behave as before this check
 *   existed for the first case and hold off for the others.
 *
 * It is NOT a second dedup store. A member who deleted their copy is asked to
 * receive it again — the same answer the manual button gives — and the ledger
 * row stays the record of what was delivered.
 */
async function alreadyCopied(
  deps: DeliveryDeps,
  member: SharedCopyMember,
  resolved: { auth: JmapAuth; session: JmapSession },
  messageId: string | null,
  inboxes: Map<string, string | null>,
): Promise<"present" | "absent" | "unknown"> {
  // A source with no Message-ID cannot be looked for, so it is retried exactly
  // as it was before this check existed: at-least-once for that one message,
  // which is the trade the header's absence forces.
  if (!messageId) return "absent";
  const personalInboxId = await personalInboxOf(deps, member, resolved, inboxes);
  if (personalInboxId === null) return "absent";
  try {
    const responses = await deps.jmap.request(resolved.auth, resolved.session, [
      [
        "Email/query",
        {
          accountId: resolved.session.accountId,
          filter: { inMailbox: personalInboxId, header: ["Message-ID", messageId] },
          limit: 1,
        },
        "q",
      ],
    ]);
    const ids = ((responses[0]?.[1] ?? {}) as { ids?: string[] }).ids ?? [];
    return ids.length > 0 ? "present" : "absent";
  } catch (error) {
    (deps.log ?? defaultLog)("warn", "shared mailbox copy: retry verification failed", {
      userId: member.userId,
      messageId,
      error: String(error),
    });
    return "unknown";
  }
}

/**
 * The moment this member became entitled to copies. Every member of a cycle
 * has one by construction — `baselineMembers` answers for every id it was
 * given — so a missing entry can only be a store that answered less than it
 * was asked; treated as "baselined now", the direction that back-fills
 * nothing.
 */
function baselineOf(baselines: Map<string, Date>, member: SharedCopyMember): Date {
  return baselines.get(member.userId) ?? new Date();
}

/**
 * One page's copies for every deliverable member. Answers whether the cycle
 * still holds the account's lease: false means another replica took the
 * account over mid-page and this one stopped where it was, with the cursor
 * deliberately left behind (see the caller).
 */
async function deliverPage(
  deps: DeliveryDeps,
  sharedAccountId: string,
  members: SharedCopyMember[],
  baselines: Map<string, Date>,
  emails: DeliverableEmail[],
  counts: DeliveryCounts,
  inboxes: Map<string, string | null>,
  owner: string,
): Promise<boolean> {
  const log = deps.log ?? defaultLog;
  const report = deps.onCopyResult ?? recordSharedMailboxCopy;
  for (const member of members) {
    // The member's share of the page: what the shared mailbox received from
    // their baseline on. The rest is the backlog their opt-in never covered,
    // and it is filtered BEFORE the ledger is asked, so a message they are not
    // entitled to costs neither a query nor a row.
    const baselinedAt = baselineOf(baselines, member);
    const entitled = emails.filter((email) => !predatesBaseline(email.receivedAt, baselinedAt));
    if (entitled.length < emails.length) {
      log("debug", "shared mailbox copy: messages before the member's baseline withheld", {
        sharedAccountId,
        userId: member.userId,
        withheld: emails.length - entitled.length,
        baselinedAt: baselinedAt.toISOString(),
      });
    }
    if (entitled.length === 0) continue;
    const resolved = await resolveMember(deps, sharedAccountId, member);
    if (!resolved) continue;
    const states = await deps.copies.copyStates(
      member.userId,
      sharedAccountId,
      entitled.map((email) => email.id),
    );
    const unresolved: string[] = [];
    let personalInboxId: string | null | undefined;
    for (const email of entitled) {
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
        email.messageId,
        email.receivedAt,
        personalInboxId === null ? undefined : { personalInboxId, keywords: email.keywords },
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
    // After this member's batch, not merely after the page: a page of a
    // hundred messages for a dozen members can outlive the TTL, and the next
    // member's copies must not be made under a lease somebody else now holds.
    if (!(await renewLeaseOrLose(deps, sharedAccountId, owner, { userId: member.userId }))) {
      return false;
    }
  }
  return true;
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
  // However old the cursor is, it is where delivery resumes. An age-based
  // re-baseline used to drop the whole gap on the guess that it was an
  // intentional pause, which is a guess the server cannot make: an outage, a
  // deploy, an account with no watcher and a swallowed cycle error all look
  // exactly the same from here. A gap DEFERS delivery — the backlog drains at
  // five pages a cycle — it never cancels it.
  let cursor = state.emailState;

  // Members this account had never seen are recorded as baselined NOW, and
  // every member — new or not — is served this cycle with exactly the messages
  // received from their own baseline on. An opt-in is forward-looking, and the
  // timestamp is what makes it so: not a one-cycle exclusion, which let the
  // backlog reach a joiner from the second cycle and cost them the mail that
  // arrived during the first.
  const baselines = await deps.copies.baselineMembers(
    sharedAccountId,
    members.map((member) => member.userId),
  );
  const deliverTo = members;

  const counts: DeliveryCounts = { copied: 0, skipped: 0, failed: 0, unresolved: 0 };
  // One personal-inbox lookup per member for the whole cycle, pages included.
  const inboxes = new Map<string, string | null>();
  // What the page read has already reported about the provider this cycle.
  const warned = { noMessageId: false };

  // Before any new page: the copies an earlier cycle could not make. The
  // cursor has already moved past the pages that carried them, so this pass is
  // the only thing that still can deliver them — and doing it first keeps a
  // transient failure from ageing out behind a busy mailbox.
  let leaseLost = !(await retryFailed(
    deps,
    sharedAccountId,
    deliverTo,
    baselines,
    counts,
    owner,
    inboxes,
  ));

  let pages = 0;
  let truncated = false;
  while (!leaseLost) {
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
      const deliverable = await inboxOnly(deps, watcher, sharedAccountId, page.created, warned);
      if (
        deliverable.length > 0 &&
        !(await deliverPage(
          deps,
          sharedAccountId,
          deliverTo,
          baselines,
          deliverable,
          counts,
          inboxes,
          owner,
        ))
      ) {
        // The lease went mid-page, so this page is only half delivered — and
        // the cursor deliberately stays where it is. Whoever holds the account
        // now re-reads the same page, and the ledger turns the copies this
        // cycle did make into skips instead of duplicates. Advancing here
        // would cost the members this cycle never reached their mail.
        leaseLost = true;
        break;
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
    // Pushed out page by page as well as per member: the TTL that survives a
    // long burst is the same TTL that has to expire before a killed holder's
    // account is delivered again, and renewing keeps those two apart. Losing
    // it means another replica already took the account over, so this cycle
    // stops rather than delivering the same pages alongside it.
    if (!(await renewLeaseOrLose(deps, sharedAccountId, owner, { pages }))) {
      leaseLost = true;
      break;
    }
  }

  log(counts.copied + counts.failed > 0 ? "info" : "debug", "shared mailbox copy: cycle finished", {
    sharedAccountId,
    ...counts,
    pages,
    truncated,
    leaseLost,
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
    // Stamped as soon as the cycle is certainly ours to run and before
    // anything in it can fail, so `last_cycle_at` means "last ATTEMPT" —
    // including a cycle that found no watcher or threw. Nothing decides
    // anything from it; it is there for the operator, and a stamp only a
    // successful advance wrote would quietly call a failing account idle.
    await deps.copies.markCycleAttempt(sharedAccountId);
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
