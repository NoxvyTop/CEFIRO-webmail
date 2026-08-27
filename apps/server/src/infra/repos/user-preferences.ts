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
//
// Exported because the PUT route has to REFUSE at the cap (GH #314, JD-3)
// rather than write a list this parse then silently truncates: a limit the
// user cannot see is worse than no limit — the badge simply never appears and
// nothing explains it. The parse below stays as the defensive backstop for
// rows written before that check existed or edited by hand.
export const MAX_TRUSTED_SERVICES = 200;

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

    // GH #314: when the one-time Sent-mailbox backfill of sent_recipients ran
    // for this user (ISO timestamp), or null if it never has. Stored under the
    // same jsonb row (key `sentRecipientsBackfilledAt`) because it is per-user
    // state with the same lifetime as the row, but read and written ONLY
    // through these two methods: it is deliberately absent from get() so it
    // never leaks into GET /api/mail/preferences, and absent from the shared
    // update schema so the generic PATCH can neither set nor clear it. A
    // hand-corrupted non-string value reads as "not backfilled" — the worst
    // that does is run the bounded backfill once more.
    async getSentRecipientsBackfilledAt(userId: string): Promise<string | null> {
      const rows = await sql<{ at: unknown }[]>`
        select preferences -> 'sentRecipientsBackfilledAt' as at
        from user_preferences where user_id = ${userId}
      `;
      const at = rows[0]?.at;
      return typeof at === "string" && at !== "" ? at : null;
    },

    async markSentRecipientsBackfilled(userId: string): Promise<void> {
      await this.merge(userId, { sentRecipientsBackfilledAt: new Date().toISOString() });
    },

    // GH #314 (JD-2): when the backfill was last ATTEMPTED, as opposed to when
    // it last succeeded. The pair is what bounds a persistently failing pass:
    // without it, a failure left no trace at all, so the whole bounded pass
    // re-ran inline on every thread read the user made, forever. Same jsonb
    // key family and the same deliberate absence from get() and from the shared
    // update schema as the marker above, for the same reasons — this is
    // server-owned bookkeeping, never client state. A hand-corrupted non-string
    // value reads as "never attempted", whose worst outcome is one more pass.
    async getSentRecipientsBackfillAttemptedAt(userId: string): Promise<string | null> {
      const rows = await sql<{ at: unknown }[]>`
        select preferences -> 'sentRecipientsBackfillAttemptedAt' as at
        from user_preferences where user_id = ${userId}
      `;
      const at = rows[0]?.at;
      return typeof at === "string" && at !== "" ? at : null;
    },

    async markSentRecipientsBackfillAttempted(userId: string, at: string): Promise<void> {
      await this.merge(userId, { sentRecipientsBackfillAttemptedAt: at });
    },

    // GH #313: every member who can take part in automatic shared-mailbox
    // copies, across ALL users — the one cross-user read this repo has. The
    // copy worker starts each cycle from it, so the filter does the worker's
    // pre-screening in the database: only ACTIVE users (a deactivated member
    // must stop receiving copies the moment the admin flips them, without
    // waiting for a preference cleanup), only users WITH a mailbox credential
    // (there is nothing to copy with otherwise, and the worker would log a
    // skip for them on every cycle), and only rows whose opt-in is a non-empty
    // jsonb array. The array check is a CASE rather than an `and` chain on
    // purpose: SQL `and` does not short-circuit, so the planner is free to
    // evaluate `jsonb_array_length` on a row before `jsonb_typeof` has ruled
    // it out, and ONE hand-corrupted scalar in any row then fails the whole
    // listing with "cannot get array length of a scalar" — taking every
    // member's copies down with it. CASE is the one construct Postgres does
    // guarantee to evaluate lazily.
    //
    // The ids still pass through parseSharedMailboxCopyOptIn so the worker
    // sees exactly the list get() would show the member; a row whose list
    // parses to nothing is dropped here rather than handed over as a member
    // with no accounts. Ordered by email so the worker's per-account member
    // order — and with it which member is elected to watch — is stable
    // between cycles.
    async listSharedMailboxCopyOptIns(): Promise<
      Array<{ userId: string; email: string; accountIds: string[] }>
    > {
      const rows = await sql<{ user_id: string; email: string; account_ids: unknown }[]>`
        select u.id as user_id, u.email, p.preferences -> 'sharedMailboxCopyOptIn' as account_ids
        from user_preferences p
        join users u on u.id = p.user_id
        join mail_credentials mc on mc.user_id = u.id
        where u.active = true
          and (
            case
              when jsonb_typeof(p.preferences -> 'sharedMailboxCopyOptIn') = 'array'
                then jsonb_array_length(p.preferences -> 'sharedMailboxCopyOptIn')
              else 0
            end
          ) > 0
        order by u.email asc
      `;
      const listed: Array<{ userId: string; email: string; accountIds: string[] }> = [];
      for (const row of rows) {
        const accountIds = parseSharedMailboxCopyOptIn(row.account_ids);
        if (accountIds.length === 0) continue;
        listed.push({ userId: row.user_id, email: row.email, accountIds });
      }
      return listed;
    },

    // GH #313: MEMBERSHIP, as opposed to deliverability above — every user
    // whose preference names at least one shared account, whether or not they
    // are active or hold a mailbox credential right now. The worker prunes
    // per-account member state against THIS list and delivers from the other:
    // pruning against the deliverable list read a member deactivated for an
    // afternoon, or momentarily without a credential, as "opted out", and
    // took their baseline and their owed `pending`/`failed` rows with it. The
    // preference is the only thing that says whether somebody is a member;
    // active/credential only say whether they can be delivered to today.
    // Same lazy CASE guard and the same defensive parse as the listing above,
    // for the same reasons; no email, because nothing here is delivered.
    async listSharedMailboxCopyOptInMembership(): Promise<
      Array<{ userId: string; accountIds: string[] }>
    > {
      const rows = await sql<{ user_id: string; account_ids: unknown }[]>`
        select p.user_id, p.preferences -> 'sharedMailboxCopyOptIn' as account_ids
        from user_preferences p
        where (
          case
            when jsonb_typeof(p.preferences -> 'sharedMailboxCopyOptIn') = 'array'
              then jsonb_array_length(p.preferences -> 'sharedMailboxCopyOptIn')
            else 0
          end
        ) > 0
      `;
      const listed: Array<{ userId: string; accountIds: string[] }> = [];
      for (const row of rows) {
        const accountIds = parseSharedMailboxCopyOptIn(row.account_ids);
        if (accountIds.length === 0) continue;
        listed.push({ userId: row.user_id, accountIds });
      }
      return listed;
    },
  };
}

export type UserPreferencesRepo = ReturnType<typeof createUserPreferencesRepo>;
