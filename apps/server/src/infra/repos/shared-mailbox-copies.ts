import type { Db } from "../db/client";

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

    async hasCopy(userId: string, sharedAccountId: string, emailId: string): Promise<boolean> {
      const rows = await sql`
        select 1 from shared_mailbox_copies
        where user_id = ${userId}
          and shared_account_id = ${sharedAccountId}
          and email_id = ${emailId}
      `;
      return rows.length > 0;
    },

    /**
     * The subset of `emailIds` this member already holds a copy of, in ONE
     * query for the whole page — the cycle checks every created id for every
     * member, and a per-id round trip would make a 100-message page cost
     * hundreds of queries per member.
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
      `;
      return new Set(rows.map((row) => row.email_id));
    },

    /**
     * Records a confirmed copy. Idempotent on purpose: a page replayed after a
     * crash between the copy and the cursor advance re-records what it finds
     * already there, and that must be a no-op rather than an error that stops
     * the page.
     */
    async recordCopy(userId: string, sharedAccountId: string, emailId: string): Promise<void> {
      await sql`
        insert into shared_mailbox_copies (user_id, shared_account_id, email_id)
        values (${userId}, ${sharedAccountId}, ${emailId})
        on conflict do nothing
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
