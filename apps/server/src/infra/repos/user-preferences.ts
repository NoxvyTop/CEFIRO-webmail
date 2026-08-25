import type postgres from "postgres";
import { customLabelSchema, type CustomLabel } from "@webmail/shared";
import { normalizeDomainName } from "../../core/domain-name";
import type { Db } from "../db/client";

const DEFAULTS = {
  groupMailInMainInbox: true,
  customLabels: [] as CustomLabel[],
  sharedMailboxCopyOptIn: [] as string[],
  trustedServices: [] as string[],
};

// GH #314: upper bound on the user's trusted-services list. Every thread read
// builds a Set from this list to resolve the badge (see the thread route), so
// a row that somehow grew without bound would tax every message the user
// opens. 200 is far above what a person confirms by hand and small enough
// that the Set is free.
const MAX_TRUSTED_SERVICES = 200;

type StoredPreferences = {
  groupMailInMainInbox: boolean;
  customLabels: CustomLabel[];
  sharedMailboxCopyOptIn: string[];
  trustedServices: string[];
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

// GH #314: defensive parse of the user's trusted-service domains. Stricter
// than the two parsers above on purpose: whatever survives here becomes a
// trust decision on the reader (a "trusted service" badge next to a sender),
// so an entry that is not a canonical domain is dropped rather than kept as
// an opaque string. normalizeDomainName lowercases and trims, so a
// hand-edited "GitHub.com" still matches the lowercased From domain, and an
// entry like "com" or "user@evil.test" never reaches the compare at all.
// Duplicates (post-normalisation) collapse to the first occurrence, and the
// list is capped at MAX_TRUSTED_SERVICES.
function parseTrustedServices(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULTS.trustedServices;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const domain = normalizeDomainName(entry);
    if (domain === null || seen.has(domain)) continue;
    seen.add(domain);
    result.push(domain);
    if (result.length >= MAX_TRUSTED_SERVICES) break;
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
        trustedServices: parseTrustedServices(stored.trustedServices),
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
