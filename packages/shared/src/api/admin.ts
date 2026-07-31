import { z } from "zod";

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["employee", "admin"]),
  locale: z.string(),
  active: z.boolean(),
  mailboxLinked: z.boolean(),
  // The user's uploaded profile photo (mirrors ProfileView.avatarDataUrl —
  // see packages/shared/src/api/profile.ts), so the admin console can show
  // it instead of always falling back to initials. Optional (rather than
  // required-and-nullable like ProfileView's) so payloads/fixtures that
  // predate this field still validate; null means "no photo".
  avatarDataUrl: z.string().nullable().optional(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

// GH #153: GET /api/admin/users paginates server-side. Before this, the
// endpoint returned *every* user in one response, and since #130 each row
// embeds the avatar as a base64 data URL (~1.37 MB at the 1 MiB
// AVATAR_MAX_BYTES cap), so the payload grew linearly and unbounded. The page
// size is defaulted and hard-capped so a single response can never carry more
// than a bounded slice of those avatars.
export const ADMIN_USERS_PAGE_SIZE_DEFAULT = 25;
export const ADMIN_USERS_PAGE_SIZE_MAX = 100;

export const adminUsersQuerySchema = z.object({
  // 1-based page index. Coerced from the query string; anything non-numeric
  // or below 1 falls back to the first page rather than erroring.
  page: z.coerce
    .number()
    .int()
    .catch(1)
    .transform((n) => (n < 1 ? 1 : n)),
  // Rows per page — defaulted, and hard-capped at ADMIN_USERS_PAGE_SIZE_MAX so
  // a client cannot ask for an unbounded page (the whole point of #153). Junk
  // falls back to the default; out-of-range values are clamped, not rejected.
  pageSize: z.coerce
    .number()
    .int()
    .catch(ADMIN_USERS_PAGE_SIZE_DEFAULT)
    .transform((n) => Math.min(Math.max(1, n), ADMIN_USERS_PAGE_SIZE_MAX)),
  // Optional case-insensitive substring filter over email/display name. An
  // empty or whitespace-only value is treated as "no filter" rather than a
  // match against the empty string.
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

// Tenant-wide aggregate counts for the admin Resumen dashboard. Deliberately
// carried alongside a page of users (rather than derived from it) so the
// metric cards stay accurate no matter which page — or search — is showing.
// Computed with cheap COUNT queries: no avatar bytes, no per-row lookups.
export const adminUsersStatsSchema = z.object({
  total: z.number(),
  active: z.number(),
  mailboxLinked: z.number(),
});
export type AdminUsersStats = z.infer<typeof adminUsersStatsSchema>;

export const adminUsersPageSchema = z.object({
  users: z.array(adminUserSchema),
  // Number of users matching the current search — drives the pager. Equals
  // stats.total when no search is applied.
  total: z.number(),
  stats: adminUsersStatsSchema,
});
export type AdminUsersPage = z.infer<typeof adminUsersPageSchema>;

export const createUserInputSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  role: z.enum(["employee", "admin"]).default("employee"),
  locale: z.string().min(2).default("es"),
  mailPassword: z.string().min(8).optional(),
});
export type CreateUserInput = z.infer<typeof createUserInputSchema>;

export const setRoleInputSchema = z.object({ role: z.enum(["employee", "admin"]) });
export type SetRoleInput = z.infer<typeof setRoleInputSchema>;

export const setActiveInputSchema = z.object({ active: z.boolean() });
export type SetActiveInput = z.infer<typeof setActiveInputSchema>;

export const setMailCredentialInputSchema = z.object({
  mailPassword: z.string().min(8),
});
export type SetMailCredentialInput = z.infer<typeof setMailCredentialInputSchema>;

export const adminSsoViewSchema = z.object({
  configured: z.boolean(),
  issuer: z.string().nullable(),
  clientId: z.string().nullable(),
  scopes: z.string().nullable(),
});
export type AdminSsoView = z.infer<typeof adminSsoViewSchema>;

// Shape shared by the admin-only GET/PUT `/admin/instance` endpoints and the
// public GET `/instance` endpoint — the flag is non-sensitive branding, so
// both surfaces read the same view.
export const instanceSettingsViewSchema = z.object({
  sentWithFooter: z.boolean(),
});
export type InstanceSettingsView = z.infer<typeof instanceSettingsViewSchema>;

export const updateInstanceSettingsSchema = z.object({
  sentWithFooter: z.boolean(),
});
export type UpdateInstanceSettingsInput = z.infer<typeof updateInstanceSettingsSchema>;
