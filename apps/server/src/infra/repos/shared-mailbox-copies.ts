import type { Db } from "../db/client";

// Advisory-lock class for the per-account delivery lock (GH #313). Same
// two-int form as the migration lock (infra/db/migrate.ts): the class is a
// fixed marker that keeps this family apart from every other advisory lock in
// the database, and the id is the shared account hashed to an int4 with
// `hashtext`, so each shared account has its own lock and two replicas
// contend only when they reach for the SAME account. 313 is this issue's
// number, which is what makes the constant greppable.
export const SHARED_COPY_LOCK_CLASS = 313;

/**
 * Cursor + dedup ledger + per-account lock for automatic shared-mailbox copies
 * (GH #313). See migrations/0015_shared_mailbox_copies.sql for what each table
 * is for and why they are two.
 */
export function createSharedMailboxCopiesRepo(sql: Db) {
  return {
    /** The last processed Email state of the shared account, or null if never baselined. */
    async getCursor(sharedAccountId: string): Promise<string | null> {
      const rows = await sql<{ email_state: string }[]>`
        select email_state from shared_mailbox_copy_state
        where shared_account_id = ${sharedAccountId}
      `;
      return rows[0]?.email_state ?? null;
    },

    async setCursor(sharedAccountId: string, emailState: string): Promise<void> {
      await sql`
        insert into shared_mailbox_copy_state (shared_account_id, email_state)
        values (${sharedAccountId}, ${emailState})
        on conflict (shared_account_id) do update set
          email_state = excluded.email_state,
          updated_at = now()
      `;
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
     * Runs `fn` while holding this account's delivery lock, or returns null
     * WITHOUT running it when another connection — another replica, or a
     * still-running cycle on this one — already holds it.
     *
     * A transaction-scoped advisory lock (`pg_try_advisory_xact_lock`) rather
     * than a session lock or a row lock: it is released on commit AND on
     * rollback, so a replica killed mid-cycle cannot leave the account wedged,
     * and it never waits — a cycle that finds the lock taken simply yields,
     * because whoever holds it is doing the same work and the next poll or
     * push will run it again. The transaction holds only the lock: the cursor
     * and ledger writes inside `fn` go through the pool's other connections
     * and commit on their own, so a crash mid-page keeps what was done (the
     * ledger makes the replay harmless — see the migration header).
     *
     * `set local statement_timeout = 0` is NOT applied here, unlike the
     * migration runner: the transaction runs exactly one instant statement
     * (the try-lock) and then sits idle while `fn` awaits, and an idle
     * transaction is not a running statement, so the pool's 30s cap never
     * fires on it.
     */
    async withAccountLock<T>(sharedAccountId: string, fn: () => Promise<T>): Promise<T | null> {
      return sql.begin(async (tx) => {
        const rows = await tx<{ locked: boolean }[]>`
          select pg_try_advisory_xact_lock(
            ${SHARED_COPY_LOCK_CLASS}::int, hashtext(${sharedAccountId})
          ) as locked
        `;
        if (!rows[0]?.locked) return null;
        return fn();
      }) as Promise<T | null>;
    },
  };
}

export type SharedMailboxCopiesRepo = ReturnType<typeof createSharedMailboxCopiesRepo>;
