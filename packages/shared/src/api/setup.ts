import { z } from "zod";

export const setupSsoSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.string().min(1).default("openid profile email"),
  // #290: optional login-button display name (e.g. "Authentik", "Google").
  // Empty/unset is treated as "SSO" by the login screen.
  providerName: z.string().max(64).optional(),
});
export type SetupSsoInput = z.infer<typeof setupSsoSchema>;

export const setupUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  role: z.enum(["employee", "admin"]).default("employee"),
  locale: z.string().min(2).default("es"),
  mailPassword: z.string().min(8),
});
export type SetupUserInput = z.infer<typeof setupUserSchema>;

export const setupStatusSchema = z.object({
  bootstrapMode: z.boolean(),
  ssoConfigured: z.boolean(),
  userCount: z.number(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;
