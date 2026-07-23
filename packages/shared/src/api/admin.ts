import { z } from "zod";

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["employee", "admin"]),
  locale: z.string(),
  active: z.boolean(),
  mailboxLinked: z.boolean(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

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
