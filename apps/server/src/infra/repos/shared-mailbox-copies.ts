import type { Db } from "../db/client";

/**
 * State of one (member, shared account, source message) in the ledger:
 * `pending` = claimed, the copy may or may not have been made; `copied` =
 * confirmed by the provider; `failed` = refused or thrown, and retryable.
 * Mirrors the check constraint in migrations/0015_shared_mailbox_copies.sql.
 */
export type SharedCopyStatus = "pending" | "copied" | "failed";

/**
 * Cursor + dedup ledger + per-account delivery lease for automatic
 * shared-mailbox copies (GH #313). See
 * migrations/0015_shared_mailbox_copies.sql for what each table is for.
 */
export function createSharedMailboxCopiesRepo(sql: Db) {
  /**
   * Forgets every member of this account that is not in `userIds`, which is
   * what makes an opt-out → opt-in round trip a fresh baseline rather than a
   * resume across the gap. An empty list is legitimate and means "nobody
   * opts into this account any more".
   *
   * Called by the worker ONLY, against the preference membership listing
   * (userPreferences.listSharedMailboxCopyOptInMembership): the delivery
   * cycle used to prune too, against the deliverable list it runs for, so a
   * member deactivated for an afternoon or momentarily without a credential
   * read as opted out and lost their baseline and their owed rows inside the
   * first cycle. Membership is what the preference says, and nothing else.
   *
   * Their OPEN ledger rows go with the baseline: a `pending` or `failed` row
   * describes a copy that was never delivered, and keeping it let the retry
   * pass hand a re-joiner mail from before they left — the very back-fill the
   * baseline exists to prevent — while orphan rows of members who never came
   * back sat at the head of `listRetryable` starving everyone else. The
   * `copied` rows stay: they are the dedup history of mail the member really
   * did receive, and losing it would deliver those messages twice.
   *
   * One statement, so the two deletes cannot disagree about who was pruned:
   * the ledger delete reads the member rows the first delete removed.
   */
  async function pruneMembers(sharedAccountId: string, userIds: string[]): Promise<void> {
    await sql`
      with pruned as (
        delete from shared_mailbox_member_state
        where shared_account_id = ${sharedAccountId}
          and not (user_id = any(${userIds}::uuid[]))
        returning user_id
      )
      delete from shared_mailbox_copies
      using pruned
      where shared_mailbox_copies.shared_account_id = ${sharedAccountId}
        and shared_mailbox_copies.user_id = pruned.user_id
        and shared_mailbox_copies.status in ('pending', 'failed')
    `;
  }

  return {
    /** The last processed Email state of the shared account, or null if never baselined. */
    async getCursor(sharedAccountId: string): Promise<string | null> {
      const rows = await sql<{ email_state: string | null }[]>`
        select email_state from shared_mailbox_copy_state
        where shared_account_id = ${sharedAccountId}
      `;
      return rows[0]?.email_state ?? null;
    },

    /**
     * The cursor AND when a cycle was last attempted for this account. Only
     * the cursor decides anything — delivery always resumes from it, however
     * old it is — so `lastCycleAt` is read alongside purely as the operator's
     * view of whether this account is being cycled at all (see the migration
     * header).
     */
    async getState(
      sharedAccountId: string,
    ): Promise<{ emailState: string | null; lastCycleAt: Date | null }> {
      const rows = await sql<{ email_state: string | null; last_cycle_at: Date | null }[]>`
        select email_state, last_cycle_at from shared_mailbox_copy_state
        where shared_account_id = ${sharedAccountId}
      `;
      return {
        emailState: rows[0]?.email_state ?? null,
        lastCycleAt: rows[0]?.last_cycle_at ?? null,
      };
    },

    /**
     * Stamps "a cycle was attempted for this account, now". Written as soon as
     * the cycle takes the lease, so the stamp covers the runs that reached no
     * member and the ones that threw — which are exactly the runs an operator
     * needs to see. Nothing in delivery decides anything from it.
     *
     * An update, not an upsert: taking the lease is what creates the row, and
     * a cycle only ever stamps under its own lease.
     */
    async markCycleAttempt(sharedAccountId: string): Promise<void> {
      await sql`
        update shared_mailbox_copy_state set
          last_cycle_at = now(),
          updated_at = now()
        where shared_account_id = ${sharedAccountId}
      `;
    },

    /**
     * Moves the cursor and refreshes `last_cycle_at` with it, so the stamp
     * covers the whole run rather than only its start. Leaves the lease
     * columns alone — the caller already holds the lease it is writing under.
     */
    async setCursor(sharedAccountId: string, emailState: string): Promise<void> {
      await sql`
        insert into shared_mailbox_copy_state (shared_account_id, email_state, last_cycle_at)
        values (${sharedAccountId}, ${emailState}, now())
        on conflict (shared_account_id) do update set
          email_state = excluded.email_state,
          last_cycle_at = now(),
          updated_at = now()
      `;
    },

    /**
     * Every shared account this deployment holds state for, whether that state
     * is a cursor/lease row or only member rows. The worker reconciles
     * membership against this list on every poll, because the prune below has
     * to reach an account NOBODY opts into any more — and such an account
     * never gets another cycle to carry it.
     */
    async listAccountIds(): Promise<string[]> {
      const rows = await sql<{ shared_account_id: string }[]>`
        select shared_account_id from shared_mailbox_copy_state
        union
        select distinct shared_account_id from shared_mailbox_member_state
      `;
      return rows.map((row) => row.shared_account_id);
    },

    pruneMembers,

    /**
     * Records every member of `userIds` that this account had not seen before
     * as baselined NOW, and answers with the baseline of every member listed
     * — the moment from which each of them is entitled to copies. The cycle
     * compares each message's `receivedAt` against it (see the migration
     * header); nobody is excluded from a cycle for being new.
     *
     * Records only, never prunes: a member absent from `userIds` is left
     * exactly as they are. The cycle calls this with the DELIVERABLE members,
     * and a member who is merely deactivated or credential-less today is
     * still a member (see `pruneMembers`).
     *
     * Two statements rather than one: the read afterwards is what makes a
     * member's baseline the one recorded — not the one this call would have
     * written — and the cycle deliberately spans no transaction.
     */
    async baselineMembers(sharedAccountId: string, userIds: string[]): Promise<Map<string, Date>> {
      if (userIds.length === 0) return new Map();
      await sql`
        insert into shared_mailbox_member_state (user_id, shared_account_id)
        select id, ${sharedAccountId}
        from unnest(${userIds}::uuid[]) as id
        on conflict (user_id, shared_account_id) do nothing
      `;
      const rows = await sql<{ user_id: string; baselined_at: Date }[]>`
        select user_id, baselined_at from shared_mailbox_member_state
        where shared_account_id = ${sharedAccountId}
          and user_id = any(${userIds}::uuid[])
      `;
      return new Map(rows.map((row) => [row.user_id, row.baselined_at]));
    },

    /** Whether this member holds a CONFIRMED copy of that message. */
    async hasCopy(userId: string, sharedAccountId: string, emailId: string): Promise<boolean> {
      const rows = await sql`
        select 1 from shared_mailbox_copies
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and email_id = ${emailId}
          and status = 'copied'
      `;
      return rows.length > 0;
    },

    /**
     * The subset of `emailIds` this member already holds a CONFIRMED copy of.
     * A claimed-but-unconfirmed row (`pending`) is deliberately not one: it
     * says a copy may have been made, which is exactly what `copyStates`
     * exists to tell apart.
     */
    async hasCopies(
      userId: string,
      sharedAccountId: string,
      emailIds: string[],
    ): Promise<Set<string>> {
      if (emailIds.length === 0) return new Set();
      const rows = await sql<{ email_id: string }[]>`
        select email_id from shared_mailbox_copies
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and email_id = any(${emailIds}::text[])
          and status = 'copied'
      `;
      return new Set(rows.map((row) => row.email_id));
    },

    /**
     * The ledger status of every one of `emailIds` this member has a row for,
     * in ONE query for the whole page — the cycle checks every created id for
     * every member, and a per-id round trip would make a 100-message page cost
     * hundreds of queries per member. An id with no row has never been
     * attempted.
     */
    async copyStates(
      userId: string,
      sharedAccountId: string,
      emailIds: string[],
    ): Promise<Map<string, SharedCopyStatus>> {
      if (emailIds.length === 0) return new Map();
      const rows = await sql<{ email_id: string; status: SharedCopyStatus }[]>`
        select email_id, status from shared_mailbox_copies
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and email_id = any(${emailIds}::text[])
      `;
      return new Map(rows.map((row) => [row.email_id, row.status]));
    },

    /**
     * Claims this copy as `pending` BEFORE the Email/copy is issued, so a
     * crash or a database failure between the provider making the copy and
     * this row being confirmed leaves evidence that it MAY have happened.
     * Later cycles skip a pending row rather than copying it again.
     *
     * A confirmed copy is never demoted (the `where`): a replayed page must
     * not turn a delivered copy back into an open question.
     *
     * `messageId` is the SOURCE message's RFC 5322 Message-ID and `receivedAt`
     * the moment the shared mailbox received it, both read with the page. The
     * first lets a later retry ask whether the copy was already made, the
     * second lets it apply the member baseline rule (see the migration
     * header). Kept with `coalesce`: the retry pass claims the row again
     * without knowing either, and that claim must not erase the answers it is
     * about to depend on.
     */
    async beginCopy(
      userId: string,
      sharedAccountId: string,
      emailId: string,
      messageId?: string | null,
      receivedAt?: Date | null,
    ): Promise<void> {
      await sql`
        insert into shared_mailbox_copies
          (user_id, shared_account_id, email_id, status, message_id, received_at)
        values (
          ${userId}, ${sharedAccountId}, ${emailId}, 'pending',
          ${messageId ?? null}, ${receivedAt ?? null}
        )
        on conflict (user_id, shared_account_id, email_id) do update set
          status = 'pending',
          message_id = coalesce(excluded.message_id, shared_mailbox_copies.message_id),
          received_at = coalesce(excluded.received_at, shared_mailbox_copies.received_at),
          updated_at = now()
        where shared_mailbox_copies.status <> 'copied'
      `;
    },

    /** Confirms a copy the provider acknowledged. */
    async markCopied(userId: string, sharedAccountId: string, emailId: string): Promise<void> {
      await sql`
        update shared_mailbox_copies set
          status = 'copied',
          last_error = null,
          copied_at = now(),
          updated_at = now()
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and email_id = ${emailId}
      `;
    },

    /**
     * Records a copy the provider refused or that threw, and counts the try.
     * The row is what makes the failure survivable: the cursor moves on (a
     * page pinned behind one member's failure would starve everyone else's
     * mail), and the next cycle's retry pass picks this up instead of the
     * message being lost with nothing but a log line behind it.
     *
     * A confirmed copy is never demoted (the `status <> 'copied'`), for the
     * same reason `beginCopy` never demotes one: the row may have reached
     * `copied` in between — the member's own manual copy-to-inbox, or another
     * holder of the account confirming the very same copy — and turning that
     * into `failed` would put a delivered message back in the retry batch and
     * deliver it twice.
     */
    async markFailed(
      userId: string,
      sharedAccountId: string,
      emailId: string,
      lastError: string,
    ): Promise<void> {
      await sql`
        update shared_mailbox_copies set
          status = 'failed',
          attempts = attempts + 1,
          last_error = ${lastError},
          updated_at = now()
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and email_id = ${emailId}
          and status <> 'copied'
      `;
    },

    /**
     * The failed copies of this account still worth another try, for the
     * members named in `userIds`: fewer than `maxAttempts` behind them, oldest
     * first, at most `limit` of them.
     *
     * Scoped to the members the caller can actually deliver to, because the
     * batch is a queue with a head: rows belonging to somebody who opted out —
     * or whom the current cycle is only baselining — used to fill the oldest
     * hundred and starve the members being served. An empty list retries
     * nothing, which is the honest reading of "nobody is deliverable".
     *
     * Bounded on both axes on purpose. `maxAttempts` is what keeps a copy that
     * cannot succeed — a message destroyed at the source, a member permanently
     * over quota — from being retried for ever; the row stays as the record of
     * a copy that will not be delivered. `limit` keeps one cycle's recovery
     * work proportional, so a provider outage that failed thousands of copies
     * is drained over several cycles instead of stalling the first one behind
     * a queue of retries while new mail waits.
     */
    async listRetryable(
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
    > {
      if (options.userIds.length === 0) return [];
      const rows = await sql<
        {
          user_id: string;
          email_id: string;
          attempts: number;
          message_id: string | null;
          received_at: Date | null;
        }[]
      >`
        select user_id, email_id, attempts, message_id, received_at from shared_mailbox_copies
        where shared_account_id = ${sharedAccountId}
          and user_id = any(${options.userIds}::uuid[])
          and status = 'failed'
          and attempts < ${options.maxAttempts}
        order by updated_at asc
        limit ${options.limit}
      `;
      return rows.map((row) => ({
        userId: row.user_id,
        emailId: row.email_id,
        attempts: row.attempts,
        messageId: row.message_id,
        receivedAt: row.received_at,
      }));
    },

    /**
     * Records the copies this account OWES a member the cycle could not
     * deliver to — their session failed, or the deliverable listing does not
     * have them at all (deactivated, no credential) — as `failed` rows with no
     * attempt spent, so the retry pass delivers them the moment the member is
     * back (GH #313).
     *
     * The cursor advances past a page whatever happens to any one member: a
     * page pinned behind one member's absence would starve everyone else's
     * mail. Without a row, that advance was the loss — nothing else remembers
     * a page the cursor has passed, so an afternoon of deactivation, or one
     * cycle with a revoked credential, cost that member every message of it.
     *
     * `attempts = 0` because nothing was attempted: the member had no session
     * to attempt it with. It is the retry pass that spends attempts, and it
     * verifies before it copies (see `beginCopy`'s `message_id`), so a row
     * written here is delivered exactly like a copy that failed on the wire.
     *
     * `on conflict do nothing`, and that is the whole safety of it: a `copied`
     * row must not be reopened, a `pending` one must not be answered, and a
     * `failed` one must keep the attempts, reason and Message-ID the retry
     * pass left on it. This writes the rows that do not exist yet and touches
     * nothing else.
     */
    async recordOwed(
      userId: string,
      sharedAccountId: string,
      rows: Array<{ emailId: string; messageId: string | null; receivedAt: Date }>,
    ): Promise<void> {
      if (rows.length === 0) return;
      await sql`
        insert into shared_mailbox_copies
          (user_id, shared_account_id, email_id, status, attempts, last_error, message_id, received_at)
        select
          ${userId}, ${sharedAccountId}, row.email_id, 'failed', 0, 'member unavailable',
          row.message_id, row.received_at
        from unnest(
          ${rows.map((row) => row.emailId)}::text[],
          ${rows.map((row) => row.messageId)}::text[],
          -- ISO strings cast in SQL, not Date objects: the driver types a
          -- Date[] parameter as a single timestamptz, which Postgres then
          -- refuses to cast to an array of one.
          ${rows.map((row) => row.receivedAt.toISOString())}::timestamptz[]
        ) as row(email_id, message_id, received_at)
        on conflict (user_id, shared_account_id, email_id) do nothing
      `;
    },

    /**
     * Moves this member's `failed` rows for `emailIds` to the TAIL of the
     * oldest-first retry batch (`updated_at = now()`) without counting an
     * attempt (GH #313).
     *
     * It exists for one member: the one on the deliverable listing whose
     * session cannot be resolved cycle after cycle — a credential revoked at
     * the provider, or an account their session no longer lists. The retry pass
     * reaches their rows, finds no session to attempt anything with, and moves
     * on; nothing was tried, so nothing may be charged to the row. But
     * `listRetryable` is `order by updated_at asc limit 100`, so rows nobody
     * ever touches own the head of the batch for ever and every OTHER member of
     * the account stops being retried. Rotating them costs the unreachable
     * member nothing (their attempts, reason and Message-ID are exactly as they
     * were, and their turn comes round again) and gives everyone else theirs.
     *
     * `status = 'failed'` scopes it deliberately: a `copied` row is history and
     * a `pending` one is an open question, and neither is in the retry batch
     * this reorders. An id with no row is silently nothing to move.
     */
    async touchRows(userId: string, sharedAccountId: string, emailIds: string[]): Promise<void> {
      if (emailIds.length === 0) return;
      await sql`
        update shared_mailbox_copies set updated_at = now()
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and email_id = any(${emailIds}::text[])
          and status = 'failed'
      `;
    },

    /**
     * How many copies this account still OWES this member: the rows `recordOwed`
     * wrote and nothing has answered yet (`failed`, no attempt spent, the reason
     * it writes). What bounds the trail (GH #313).
     *
     * The trail grows by one row per message per page for as long as a member
     * cannot be served, and "cannot be served" is not always temporary — a
     * revoked credential is a permanent state nothing here can end. Without a
     * bound that is unlimited growth in a table with no retention, for mail
     * that will never be handed over. The cycle stops writing at
     * DELIVERY_OWED_CAP outstanding rows (see the delivery module).
     *
     * The three conditions are exactly `recordOwed`'s own signature, so a row
     * the retry pass has since spent an attempt on stops counting: it is an
     * ordinary failed copy from that moment, ageing out under the attempt cap.
     */
    async countOwed(userId: string, sharedAccountId: string): Promise<number> {
      const rows = await sql<{ owed: string }[]>`
        select count(*) as owed from shared_mailbox_copies
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and status = 'failed'
          and attempts = 0
          and last_error = 'member unavailable'
      `;
      return Number(rows[0]?.owed ?? 0);
    },

    /**
     * Records a confirmed copy in one step, for the manual copy route, which
     * has no cycle around it to claim the row first. Idempotent: a member who
     * presses the button twice, or presses it for mail a cycle already
     * delivered, must not get an error.
     */
    async recordCopy(userId: string, sharedAccountId: string, emailId: string): Promise<void> {
      await sql`
        insert into shared_mailbox_copies (user_id, shared_account_id, email_id, status)
        values (${userId}, ${sharedAccountId}, ${emailId}, 'copied')
        on conflict (user_id, shared_account_id, email_id) do update set
          status = 'copied',
          last_error = null,
          copied_at = now(),
          updated_at = now()
      `;
    },

    /**
     * Takes this account's delivery lease for `owner` until `ttlMs` from now,
     * answering whether it was taken. False means somebody else — another
     * replica, or a still-running cycle on this one — holds a live lease, and
     * the caller must not deliver.
     *
     * ONE atomic statement, which is what makes it safe without a transaction:
     * the `on conflict ... do update ... where` runs under the row lock the
     * insert already took, so two replicas racing for a free lease serialise
     * on it and exactly one of them gets a row back. A read-then-write pair
     * would let both read "free" and both write.
     *
     * A lease is taken when there is none, when the previous one has expired
     * (a replica killed mid-cycle heals itself after `ttlMs` instead of
     * wedging the account, which is what the advisory lock's rollback used to
     * give us) or when the asker already owns it (a re-entered cycle).
     *
     * The row doubles as the cursor row: an account leased before it was ever
     * baselined simply has a null `email_state`.
     */
    async acquireLease(sharedAccountId: string, owner: string, ttlMs: number): Promise<boolean> {
      const rows = await sql`
        insert into shared_mailbox_copy_state (shared_account_id, lease_owner, lease_until)
        values (
          ${sharedAccountId},
          ${owner},
          now() + make_interval(secs => ${ttlMs}::double precision / 1000)
        )
        on conflict (shared_account_id) do update set
          lease_owner = excluded.lease_owner,
          lease_until = excluded.lease_until,
          updated_at = now()
        where shared_mailbox_copy_state.lease_until is null
          or shared_mailbox_copy_state.lease_until < now()
          or shared_mailbox_copy_state.lease_owner = excluded.lease_owner
        returning shared_account_id
      `;
      return rows.length > 0;
    },

    /**
     * Pushes this account's lease out by another `ttlMs`, for its owner only.
     * Called after every page so a cycle longer than the TTL is not taken over
     * mid-flight, while a cycle that dies still expires on schedule. False
     * means the lease is somebody else's now — the caller has lost it and must
     * stop delivering.
     */
    async renewLease(sharedAccountId: string, owner: string, ttlMs: number): Promise<boolean> {
      const rows = await sql`
        update shared_mailbox_copy_state set
          lease_until = now() + make_interval(secs => ${ttlMs}::double precision / 1000),
          updated_at = now()
        where shared_account_id = ${sharedAccountId}
          and lease_owner = ${owner}
        returning shared_account_id
      `;
      return rows.length > 0;
    },

    /**
     * Hands the lease back, so the next push or poll can deliver immediately
     * instead of waiting out the TTL. Scoped to the owner: a cycle that lost
     * its lease to an expiry takeover must not free the lease of whoever took
     * it over.
     */
    async releaseLease(sharedAccountId: string, owner: string): Promise<void> {
      await sql`
        update shared_mailbox_copy_state set
          lease_owner = null,
          lease_until = null,
          updated_at = now()
        where shared_account_id = ${sharedAccountId}
          and lease_owner = ${owner}
      `;
    },
  };
}

export type SharedMailboxCopiesRepo = ReturnType<typeof createSharedMailboxCopiesRepo>;
