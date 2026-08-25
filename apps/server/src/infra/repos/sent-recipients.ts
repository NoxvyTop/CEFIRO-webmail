import type { Db } from "../db/client";

// GH #314: the Tier A ("known sender") store — see 0014_sent_recipients.sql
// for why this is its own table and not a `source` on `contacts`.
//
// Normalisation lives here, on every write AND every read, rather than in the
// three callers (POST /send, the sent-mailbox harvest, the backfill): the
// primary key is (user_id, email) on the stored lowercased form, so a caller
// that forgot to lowercase would create a second row for "Ana@x.test" and a
// reader that forgot would miss it. Doing it in one place keeps the invariant
// where the table is. Entries without an "@" are dropped rather than stored —
// JMAP always hands back full addresses, so anything else is a malformed
// fixture or a group/undisclosed placeholder, neither of which is an address
// the user knows.
function normalizeAddresses(emails: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of emails) {
    if (typeof raw !== "string") continue;
    const email = raw.trim().toLowerCase();
    if (email === "" || !email.includes("@")) continue;
    seen.add(email);
  }
  return [...seen];
}

export function createSentRecipientsRepo(sql: Db) {
  return {
    // Bulk, idempotent upsert: one statement for the whole batch, conflicts
    // ignored so the original first_sent_at survives a re-send. Callers treat
    // this as best-effort (they catch and log), so it neither retries nor
    // wraps a transaction — a single INSERT is already atomic.
    async record(userId: string, emails: string[]): Promise<void> {
      const addresses = normalizeAddresses(emails);
      if (addresses.length === 0) return;
      const rows = addresses.map((email) => [userId, email]);
      await sql`
        insert into sent_recipients (user_id, email)
        select v.user_id::uuid, v.email
        from (values ${sql(rows)}) as v(user_id, email)
        on conflict (user_id, email) do nothing
      `;
    },

    // Which of `emails` this user has written to, as a Set of the normalized
    // (lowercased) addresses. One `= any($1)` query for the whole batch: the
    // thread route asks once per request for every distinct sender of the
    // thread, and a query per message would scale with thread length.
    async has(userId: string, emails: string[]): Promise<Set<string>> {
      const addresses = normalizeAddresses(emails);
      if (addresses.length === 0) return new Set();
      const rows = await sql<{ email: string }[]>`
        select email from sent_recipients
        where user_id = ${userId} and email = any(${addresses}::text[])
      `;
      return new Set(rows.map((row) => row.email));
    },
  };
}

export type SentRecipientsRepo = ReturnType<typeof createSentRecipientsRepo>;
