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
     * The cursor AND when it was last moved. The two are read together because
     * the cycle needs both to decide whether to resume or to re-baseline: a
     * cursor with no recent cycle behind it points at a backlog, not at a gap
     * worth replaying (see the migration header).
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
     * Moves the cursor and stamps `last_cycle_at`, always together: a cursor
     * whose age is unknown is the one the next cycle cannot tell apart from a
     * week-old backlog. Leaves the lease columns alone — the caller already
     * holds the lease it is writing under.
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
     * Records every member of `userIds` that this account had not seen before,
     * at `baselinedState`, and answers with exactly those ids — the members
     * that must NOT receive copies this cycle. Everyone else in the list is
     * deliverable.
     *
     * Also forgets members who are no longer in the list, which is what makes
     * an opt-out → opt-in round trip a fresh baseline rather than a back-fill
     * of everything that arrived while they were away.
     *
     * Two statements rather than one: the prune and the insert touch disjoint
     * rows (out of the list vs. in it), so there is nothing to make atomic
     * between them, and the cycle deliberately spans no transaction.
     */
    async baselineMembers(
      sharedAccountId: string,
      userIds: string[],
      baselinedState: string,
    ): Promise<string[]> {
      await sql`
        delete from shared_mailbox_member_state
        where shared_account_id = ${sharedAccountId}
          and not (user_id = any(${userIds}::uuid[]))
      `;
      if (userIds.length === 0) return [];
      const rows = await sql<{ user_id: string }[]>`
        insert into shared_mailbox_member_state (user_id, shared_account_id, baselined_state)
        select id, ${sharedAccountId}, ${baselinedState}
        from unnest(${userIds}::uuid[]) as id
        on conflict (user_id, shared_account_id) do nothing
        returning user_id
      `;
      return rows.map((row) => row.user_id);
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
     */
    async beginCopy(userId: string, sharedAccountId: string, emailId: string): Promise<void> {
      await sql`
        insert into shared_mailbox_copies (user_id, shared_account_id, email_id, status)
        values (${userId}, ${sharedAccountId}, ${emailId}, 'pending')
        on conflict (user_id, shared_account_id, email_id) do update set
          status = 'pending',
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
      `;
    },

    /**
     * The failed copies of this account still worth another try: fewer than
     * `maxAttempts` behind them, oldest first, at most `limit` of them.
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
      options: { maxAttempts: number; limit: number },
    ): Promise<Array<{ userId: string; emailId: string; attempts: number }>> {
      const rows = await sql<{ user_id: string; email_id: string; attempts: number }[]>`
        select user_id, email_id, attempts from shared_mailbox_copies
        where shared_account_id = ${sharedAccountId}
          and status = 'failed'
          and attempts < ${options.maxAttempts}
        order by updated_at asc
        limit ${options.limit}
      `;
      return rows.map((row) => ({
        userId: row.user_id,
        emailId: row.email_id,
        attempts: row.attempts,
      }));
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
