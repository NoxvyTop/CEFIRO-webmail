import type { Db } from "../db/client";

// #307: the store behind the AI-summary cache. Generating a summary calls a paid
// LLM provider, so a repeat request for the same content reads the bullets back
// from here instead of re-billing the account (see modules/ai/router.ts for how
// the content_key is derived per kind).

/** Whether a cached summary is for a single message or a whole thread. */
export type SummaryKind = "message" | "thread";

type SummaryRow = { bullets: string | string[] };

export function createAiSummariesRepo(sql: Db) {
  return {
    /**
     * The cached bullets for one (user, kind, target, content) entry, or null on
     * a miss. `contentKey` is what keeps this stale-safe: for a message it is the
     * (immutable) message id, for a thread it is a hash of its ordered email ids,
     * so a grown thread asks under a new key and misses rather than returning a
     * stale summary.
     */
    async get(
      userId: string,
      kind: SummaryKind,
      targetId: string,
      contentKey: string,
    ): Promise<string[] | null> {
      const rows = await sql<SummaryRow[]>`
        select bullets
        from email_ai_summaries
        where user_id = ${userId}
          and kind = ${kind}
          and target_id = ${targetId}
          and content_key = ${contentKey}
        limit 1
      `;
      const row = rows[0];
      if (!row) return null;
      // jsonb arrays arrive as strings under Bun + postgres.js (same as
      // filter-rules.ts); parse them back into the string[] the reader renders.
      return typeof row.bullets === "string" ? JSON.parse(row.bullets) : row.bullets;
    },

    /**
     * Create-or-update the entry for one (user, kind, target, content). Upsert
     * rather than insert so a regeneration under the SAME key (e.g. a manual
     * retry) refreshes the bullets in place instead of tripping the unique
     * constraint. Only ever called after a SUCCESSFUL generation.
     */
    async put(
      userId: string,
      kind: SummaryKind,
      targetId: string,
      contentKey: string,
      bullets: string[],
    ): Promise<void> {
      await sql`
        insert into email_ai_summaries (user_id, kind, target_id, content_key, bullets)
        values (${userId}, ${kind}, ${targetId}, ${contentKey}, ${JSON.stringify(bullets)}::jsonb)
        on conflict (user_id, kind, target_id, content_key) do update set
          bullets = excluded.bullets,
          created_at = now()
      `;
    },
  };
}

export type AiSummariesRepo = ReturnType<typeof createAiSummariesRepo>;
