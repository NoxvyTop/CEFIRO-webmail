import type postgres from "postgres";
import { customLabelSchema, type CustomLabel } from "@webmail/shared";
import type { Db } from "../db/client";

const DEFAULTS = {
  groupMailInMainInbox: true,
  customLabels: [] as CustomLabel[],
  sharedMailboxCopyOptIn: [] as string[],
};

type StoredPreferences = {
  groupMailInMainInbox: boolean;
  customLabels: CustomLabel[];
  sharedMailboxCopyOptIn: string[];
};

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

// GH #13/#50 (G-3): defensive parse of the opted-in shared-account id list.
// The authorized PUT route always writes a clean, de-duplicated list, so this
// only guards rows written before the field existed or corrupted by hand:
// non-string and empty entries are dropped and duplicates collapsed, rather
// than failing the whole GET (same rationale as parseCustomLabels above).
function parseSharedMailboxCopyOptIn(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULTS.sharedMailboxCopyOptIn;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function createUserPreferencesRepo(sql: Db) {
  return {
    async get(userId: string): Promise<StoredPreferences> {
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
        sharedMailboxCopyOptIn: parseSharedMailboxCopyOptIn(stored.sharedMailboxCopyOptIn),
      };
    },
    async merge(userId: string, patch: Record<string, unknown>): Promise<StoredPreferences> {
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
