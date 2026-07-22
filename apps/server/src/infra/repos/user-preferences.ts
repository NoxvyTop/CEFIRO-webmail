import type postgres from "postgres";
import { customLabelSchema, type CustomLabel } from "@webmail/shared";
import type { Db } from "../db/client";

const DEFAULTS = { groupMailInMainInbox: true, customLabels: [] as CustomLabel[] };

// Defensive parse for whatever is stored in the jsonb column: the PUT route
// already validates shape via userPreferencesUpdateSchema (zod), so this only
// matters for rows written before this field existed or corrupted by hand —
// malformed entries are dropped rather than failing the whole GET, and
// duplicate slugs (case-insensitive) are collapsed to the first occurrence.
function parseCustomLabels(value: unknown): CustomLabel[] {
  if (!Array.isArray(value)) return DEFAULTS.customLabels;
  const result: CustomLabel[] = [];
  const seenSlugs = new Set<string>();
  for (const entry of value) {
    const parsed = customLabelSchema.safeParse(entry);
    if (!parsed.success) continue;
    const key = parsed.data.slug.toLowerCase();
    if (seenSlugs.has(key)) continue;
    seenSlugs.add(key);
    result.push(parsed.data);
  }
  return result;
}

export function createUserPreferencesRepo(sql: Db) {
  return {
    async get(userId: string): Promise<{ groupMailInMainInbox: boolean; customLabels: CustomLabel[] }> {
      const rows = await sql<{ preferences: Record<string, unknown> }[]>`
        select preferences from user_preferences where user_id = ${userId}
      `;
      const stored = rows[0]?.preferences ?? {};
      return {
        groupMailInMainInbox:
          typeof stored.groupMailInMainInbox === "boolean"
            ? stored.groupMailInMainInbox
            : DEFAULTS.groupMailInMainInbox,
        customLabels: parseCustomLabels(stored.customLabels),
      };
    },
    async merge(
      userId: string,
      patch: Record<string, unknown>,
    ): Promise<{ groupMailInMainInbox: boolean; customLabels: CustomLabel[] }> {
      await sql`
        insert into user_preferences (user_id, preferences)
        values (${userId}, ${sql.json(patch as postgres.JSONValue)})
        on conflict (user_id) do update set
          preferences = user_preferences.preferences || excluded.preferences
      `;
      return this.get(userId);
    },
  };
}

export type UserPreferencesRepo = ReturnType<typeof createUserPreferencesRepo>;
