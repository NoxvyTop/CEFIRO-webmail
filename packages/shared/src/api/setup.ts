import { z } from "zod";

export const setupSsoSchema = z.object({
  // GH #347: an http issuer lets whoever controls the network path answer
  // discovery on the IdP's behalf and receive the client_secret at a
  // token_endpoint of their choosing. Setup and the admin SSO form
  // (modules/admin/router.ts, modules/setup/router.ts) are the only places an
  // operator supplies an issuer, so https: is required at the one point that
  // can refuse it before any row is ever written. apps/server's own OIDC
  // client (modules/auth/oidc.ts discover()) re-checks this at read time —
  // defense in depth for a row written before this existed, or written
  // directly against the database — and validates the endpoints discovery
  // itself returns, which this schema has no visibility into.
  issuer: z
    .string()
    .url()
    .refine(
      (value) => {
        // `.url()` above already reports its own issue for a string that is
        // not a URL at all — but zod still runs a chained `.refine()` in that
        // case (a failed string-level check like `.url()` only marks the
        // result "dirty", not "aborted", and only "aborted" skips a chained
        // effect). `new URL()` throws on exactly the input `.url()` already
        // flagged, so this must not call it unguarded: an uncaught throw here
        // escapes safeParse() as a raw TypeError instead of a clean
        // `{ success: false }`, which is a 500 instead of a 400 at every
        // caller (admin/setup routers both use safeParse, never the
        // throwing parse()).
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "issuer must be an https: URL" },
    ),
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
