import { z } from "zod";

export const sessionUserSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["employee", "admin"]),
  locale: z.string(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const authModeSchema = z.object({
  bootstrapMode: z.boolean(),
  // #290: the configured SSO provider name for the login button. Defaults to
  // "SSO", so a response (or test stub) that omits it still parses.
  providerName: z.string().default("SSO"),
  // #305: whether first-run setup has finished (an active admin exists and SSO
  // is configured — the #234 completion latch). The login screen reads it from
  // this PUBLIC probe to decide whether to surface the first-run setup CTA, so
  // it no longer has to poll the authenticated `GET /api/setup/status`, which
  // recorded a `setup.auth_failed` audit row on every unauthenticated hit
  // (#287). Defaults to `true` — "no wizard to point at" is the safe default
  // for any response (or test stub) that omits it, matching a normal
  // already-set-up instance.
  setupComplete: z.boolean().default(true),
});
export type AuthMode = z.infer<typeof authModeSchema>;

export const bootstrapLoginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});
export type BootstrapLoginInput = z.infer<typeof bootstrapLoginSchema>;

/**
 * Every value the OIDC login flow can put in the `?auth_error=` query parameter
 * when it sends the browser back to the login screen.
 *
 * A redirect is the one server answer that carries no ApiError envelope, so
 * there is nothing on the wire for the login screen to fall back to: a code it
 * does not recognise renders as no message at all, and the user sees a login
 * form that looks like nothing happened and retries the thing that just failed.
 * That is exactly what `account_archived` did (GH #232) — the same shape of gap
 * GH #215 closed for the mail error codes.
 *
 * It lives in the shared contract, next to the schemas, rather than as a set in
 * the login page, because the two halves are in different packages: the server
 * (apps/server/src/modules/auth/router.ts) redirects with these, the web app
 * (apps/web/src/features/auth) has to have a message for each. A list on only
 * one side is a list that can silently fall behind the other — which is how the
 * gap opened in the first place.
 */
export const AUTH_ERROR_CODES = [
  /** The signed OIDC state cookie was missing, stale or did not match. */
  "state",
  /** The IdP authenticated an account this instance has archived (GH #232). */
  "account_archived",
  /** The IdP asserts the address but has not verified it (GH #46). */
  "oidc_email_unverified",
  /** Anything else that broke the callback: IdP down, bad secret, clock skew… */
  "oidc",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
