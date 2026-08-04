import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bootstrapLoginSchema, type AuthErrorCode } from "@webmail/shared";
import type { AuditRepo } from "../../infra/repos/audit";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UsersRepo } from "../../infra/repos/users";
import type { Bootstrap } from "../setup/bootstrap";
import { clientIp, DEFAULT_TRUSTED_PROXY_HOPS, rateLimitKey } from "../../core/client-ip";
import { errorResponse } from "../../core/error-response";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import { createRateLimiter, type RateLimiter } from "../../core/rate-limit";
import { evictMailSession } from "../mail/context";
import { SESSION_COOKIE, requireSession, type AuthVariables } from "./middleware";
import {
  buildAuthUrl,
  createIdTokenVerifier,
  createPkce,
  discover,
  exchangeCode,
  remoteKeySource,
  type OidcEndpoints,
} from "./oidc";
import { OIDC_STATE_COOKIE, openState, sealState } from "./oidc-state";
import type { SessionStore } from "./sessions";

export type OidcClient = {
  discover(issuer: string): Promise<OidcEndpoints>;
  exchangeCode(input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<{ idToken: string }>;
  createVerifier(input: {
    jwksUri: string;
    issuer: string;
    clientId: string;
  }): (idToken: string) => Promise<{ email: string }>;
};

// TEMP local demo tweak (do NOT commit; revert after review): point the emergency
// login at the seeded mailbox account so it lands on real mail + the admin console.
const BOOTSTRAP_ADMIN_EMAIL = "bootstrap-admin@webmail.local";

/**
 * The steps of the OIDC callback, in order (GH #237).
 *
 * Every one of them could fail, and every failure landed on the same
 * `?auth_error=oidc` redirect and the same `login.failed` audit row with actor
 * `"system"` — an IdP that is down, a clock out of skew, a wrong client secret,
 * a JWKS that would not load and a Postgres error inside `users.create` were
 * one indistinguishable outcome. A login incident in production had literally
 * nothing to read. This is what makes them tell each other apart.
 */
type CallbackStage =
  | "sso_config"
  | "discovery"
  | "token_exchange"
  | "id_token"
  | "user_lookup"
  | "user_provision"
  | "session";

/**
 * What is safe to publish about a caught error: its class, plus the code when
 * it is one of ours.
 *
 * Deliberately NOT the message. The class alone already separates the causes
 * that matter — `JWTExpired` (clock skew) from `JWSSignatureVerificationFailed`
 * (wrong key) from `JWKSNoMatchingKey` from `DomainError`+`oidc_unavailable`
 * (provider unreachable) from `PostgresError` — while a message is
 * attacker-influenced text of unknown provenance travelling into the log
 * stream, and the one thing this flow handles is an id_token. Nothing here can
 * carry a token, a client secret or a password, which is the property that has
 * to hold no matter what upstream library throws next.
 */
function errorFields(error: unknown): { errorClass: string; errorCode?: string } {
  if (error instanceof DomainError) return { errorClass: error.name, errorCode: error.code };
  if (error instanceof Error) return { errorClass: error.name };
  return { errorClass: typeof error };
}

/**
 * The login-screen redirect for a failed callback (GH #232).
 *
 * Typed against AUTH_ERROR_CODES in @webmail/shared rather than taking a bare
 * string, so a new failure cause cannot be redirected with a code the login
 * screen has no message for — the whole failure this issue is about. Adding one
 * means adding it to the shared list, which is what the web-side coverage walk
 * (features/auth/auth-errors.test.tsx) reads.
 */
function authErrorRedirect(c: { redirect: (url: string) => Response }, code: AuthErrorCode) {
  return c.redirect(`/?auth_error=${code}`);
}

/**
 * Which login-screen code a failed callback deserves.
 *
 * Only the unverified-address refusal is named. It is the one cause the person
 * in front of the browser can actually act on — their IdP asserts the address
 * but has not verified it, and no amount of retrying will change that — so
 * answering "sign-in could not be completed" leaves them looping on a login
 * that cannot succeed (GH #46). Everything else stays generic on purpose: an
 * IdP outage, a wrong client secret, a skewed clock or a Postgres failure are
 * operator problems, and naming them to an unauthenticated caller would only
 * hand out a map of this deployment's internals. They are already distinguished
 * where it helps — the `stage` in the log line and the audit row (GH #237).
 */
function callbackErrorCode(error: unknown): AuthErrorCode {
  return error instanceof DomainError && error.code === "oidc_email_unverified"
    ? "oidc_email_unverified"
    : "oidc";
}

// Rate limit for the break-glass bootstrap login, keyed by client IP.
//
// This is NOT a brute-force ceiling: the bootstrap password is 18 random bytes
// (144 bits, see setup/bootstrap.ts), so guessing it at any rate is infeasible.
// It exists to refuse a flood cheaply. The endpoint is reachable UNAUTHENTICATED
// while bootstrap mode is on, and each failed attempt used to write a
// `bootstrap.login_failed` audit row — measured at ~94 req/s with no ceiling
// (GH #183), an audit-log (and disk) flooding vector. 10 attempts per minute
// per IP leaves an operator who fat-fingers the long random password several
// times unaffected, while a flood is blocked after the first handful and every
// further request is refused before it can parse a body, verify a password, or
// write audit. Lockout lasts at most one window (~60s), acceptable on a
// deliberate emergency path.
const BOOTSTRAP_LOGIN_MAX_ATTEMPTS = 10;
const BOOTSTRAP_LOGIN_WINDOW_MS = 60_000;

// Rate limit for GET /login (GH #194), keyed by client IP. Each hit triggers an
// outbound oidc.discover() to the IdP, so an unbounded endpoint amplifies one
// cheap request into a request against the IdP plus discovery work here. 15 per
// minute per IP is well above what a human bouncing off an expired session
// needs, yet caps a flood after the first handful — every further request is
// refused before the discovery call runs.
const LOGIN_MAX_ATTEMPTS = 15;
const LOGIN_WINDOW_MS = 60_000;

const defaultOidcClient: OidcClient = {
  discover: (issuer) => discover(issuer),
  exchangeCode: (input) => exchangeCode(input),
  createVerifier: ({ jwksUri, issuer, clientId }) =>
    createIdTokenVerifier({ issuer, clientId, keySource: remoteKeySource(jwksUri) }),
};

export type AuthRouterDeps = {
  sessions: SessionStore;
  users?: UsersRepo;
  audit?: AuditRepo;
  ssoConfig?: SsoConfigRepo;
  masterKey?: CryptoKey;
  appUrl?: string;
  sessionTtlHours?: number;
  oidcClient?: OidcClient;
  bootstrap?: Bootstrap;
  rateLimiter?: RateLimiter;
  loginRateLimiter?: RateLimiter;
  /**
   * Proxy hops to trust in `X-Forwarded-For` (GH #238). Both ceilings below and
   * the audit `ip` column are keyed off it; see core/client-ip.ts.
   */
  trustedProxyHops?: number;
};

export function createAuthRouter(deps: AuthRouterDeps) {
  const router = new Hono<{ Variables: AuthVariables }>();
  const oidc = deps.oidcClient ?? defaultOidcClient;
  const trustedProxyHops = deps.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;
  // One limiter per router instance, living in this closure so its counters
  // persist across requests. Injectable so tests can drive a small limit.
  const bootstrapRateLimiter =
    deps.rateLimiter ??
    createRateLimiter({ limit: BOOTSTRAP_LOGIN_MAX_ATTEMPTS, windowMs: BOOTSTRAP_LOGIN_WINDOW_MS });
  // Rate limit for the unauthenticated OIDC login start, keyed by client IP.
  // GET /login fires an outbound oidc.discover() to the IdP on every hit, so
  // without a ceiling it is a cheap amplification/DoS lever against both the
  // IdP and this process (GH #194). Same fixed-window limiter as the bootstrap
  // path; the number is generous for a human who clicks "sign in" a few times
  // but refuses a flood before the outbound discovery ever runs.
  const loginRateLimiter =
    deps.loginRateLimiter ??
    createRateLimiter({ limit: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_WINDOW_MS });

  // Whether to mark a cookie `Secure`, derived from the scheme the CLIENT
  // actually used to reach the edge — read per request, not from NODE_ENV
  // (GH #288). This replaces the GH #196 "force Secure in production" floor: that
  // floor was added because deriving Secure from APP_URL's scheme dropped it
  // when an operator ran APP_URL=http behind a TLS-terminating proxy — but it is
  // wrong the other way, because on a plain-HTTP edge served from a
  // non-`.localhost` domain the browser refuses a Secure cookie outright, so the
  // OIDC state cookie is never stored and login cannot complete. The effective
  // request scheme is the correct signal behind BOTH an HTTP edge (not Secure)
  // and an HTTPS edge (Secure), and needs no NODE_ENV.
  const cookieSecure = (c: {
    req: { header(name: string): string | undefined; url: string };
  }): boolean => {
    // Trust X-Forwarded-Proto only as far as the operator's proxy contract goes
    // (TRUSTED_PROXY_HOPS). When it is a comma-separated chain, read the entry
    // the SAME way core/client-ip.ts attributes the client IP: count trusted
    // hops from the RIGHT (the end a client cannot reach) and take that hop's
    // scheme. A chain shorter than the declared hop count — or no header at all
    // — did not travel the described path, so fall through to the direct scheme.
    if (trustedProxyHops > 0) {
      const forwardedProto = c.req.header("x-forwarded-proto");
      if (forwardedProto) {
        const chain = forwardedProto.split(",");
        const index = chain.length - trustedProxyHops;
        if (index >= 0) {
          const scheme = chain[index]?.trim().toLowerCase() ?? "";
          if (scheme !== "") return scheme === "https";
        }
      }
    }
    // No trusted proxy (or nothing usable in the header): the scheme on the
    // socket this process terminates is the real one.
    return new URL(c.req.url).protocol === "https:";
  };

  router.get("/me", requireSession(deps.sessions), (c) => c.json(c.get("user")));

  router.get("/mode", async (c) => {
    // #290: the login-button provider name is configurable per deployment.
    // Resolve it from the stored SSO config without decrypting any secret; a
    // blank value, no config, or a read failure all fall back to "SSO" so this
    // public probe never breaks on the SSO side.
    let providerName = "SSO";
    try {
      const stored = (await deps.ssoConfig?.getProviderName())?.trim();
      if (stored) providerName = stored;
    } catch {
      // Keep the default; the mode probe must answer regardless.
    }
    return c.json({ bootstrapMode: deps.bootstrap?.enabled ?? false, providerName });
  });

  router.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const sessionUser = await deps.sessions.findUser(token);
      if (sessionUser) evictMailSession(sessionUser.userId);
      await deps.sessions.revoke(token);
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  router.get("/login", async (c) => {
    const { ssoConfig, masterKey, appUrl } = deps;
    if (!ssoConfig || !masterKey || !appUrl) {
      return errorResponse(c, "sso_not_configured", 503);
    }
    // Client IP counted from the RIGHT of X-Forwarded-For, one shared bucket
    // when it cannot be attributed (GH #238). This used to take the LEFTMOST
    // entry, which under the appending proxy this deployment documents is
    // exactly the part the caller wrote — so rotating the header handed out a
    // fresh budget per request and the ceiling GH #194 added never bound
    // anything. See core/client-ip.ts.
    //
    // Gate BEFORE the outbound oidc.discover(): a flood is refused cheaply and
    // never amplifies into a discovery request against the IdP.
    const gate = loginRateLimiter.check(rateLimitKey(c, trustedProxyHops));
    if (!gate.allowed) {
      c.header("Retry-After", String(gate.retryAfterSeconds));
      return errorResponse(c, "too_many_requests", 429);
    }
    const sso = await ssoConfig.get();
    if (!sso) {
      return errorResponse(c, "sso_not_configured", 503);
    }
    const endpoints = await oidc.discover(sso.issuer);
    const { verifier, challenge } = await createPkce();
    const state = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    setCookie(c, OIDC_STATE_COOKIE, await sealState(masterKey, { state, verifier, issuedAt: Date.now() }), {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      secure: cookieSecure(c),
      maxAge: 600,
    });
    return c.redirect(
      buildAuthUrl({
        authorizationEndpoint: endpoints.authorizationEndpoint,
        clientId: sso.clientId,
        redirectUri: `${appUrl}/api/auth/callback`,
        state,
        challenge,
        scopes: sso.scopes,
      }),
    );
  });

  router.post("/bootstrap", async (c) => {
    const { bootstrap, users, audit } = deps;
    if (!bootstrap?.enabled || !users || !audit) {
      return errorResponse(c, "not_found", 404);
    }
    // Client IP for the rate gate and the audit row, attributed by counting
    // trusted hops from the RIGHT of X-Forwarded-For (GH #238). This used to be
    // the RAW header: the whole comma-separated string became the key, so a
    // caller who appended one junk hop per attempt got an unlimited number of
    // fresh buckets — and the same string was written verbatim into the audit
    // `ip` column, which is how that column got poisoned rather than filled.
    const ip = clientIp(c, trustedProxyHops);
    // Gate BEFORE parsing the body, verifying the password, or writing any
    // audit row: a flood is refused cheaply and — the point of GH #183 — a
    // blocked request produces ZERO `bootstrap.login_failed` rows.
    const gate = bootstrapRateLimiter.check(rateLimitKey(c, trustedProxyHops));
    if (!gate.allowed) {
      c.header("Retry-After", String(gate.retryAfterSeconds));
      return errorResponse(c, "too_many_requests", 429);
    }
    let body: { email: string; password: string };
    try {
      const parsed = bootstrapLoginSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return errorResponse(c, "invalid_body", 400);
      }
      body = parsed.data;
    } catch (error) {
      // GH #237: the class of the parse failure, at `debug` because an
      // unreadable body is a client mistake and not something an operator
      // should be paged about — but it is no longer thrown away, so raising
      // LOG_LEVEL is enough to see it when a client claims it is sending JSON.
      log("debug", "bootstrap login body unreadable", errorFields(error));
      return errorResponse(c, "invalid_body", 400);
    }
    const ok = await bootstrap.verify(body.password);
    if (!ok) {
      await audit.record({ actor: BOOTSTRAP_ADMIN_EMAIL, action: "bootstrap.login_failed", ip });
      return errorResponse(c, "unauthorized", 401);
    }
    let admin = await users.findByEmail(BOOTSTRAP_ADMIN_EMAIL);
    if (!admin) {
      admin = await users.create({
        email: BOOTSTRAP_ADMIN_EMAIL,
        displayName: "Bootstrap Admin",
        role: "admin",
      });
    } else {
      if (!admin.active) await users.setActive(admin.id, true);
      if (admin.role !== "admin") await users.setRole(admin.id, "admin");
    }
    const ttl = deps.sessionTtlHours ?? 12;
    const { token } = await deps.sessions.create(admin.id, ttl);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      secure: cookieSecure(c),
      maxAge: ttl * 3600,
    });
    await audit.record({ actor: BOOTSTRAP_ADMIN_EMAIL, action: "bootstrap.login", ip });
    return c.json({ ok: true });
  });

  router.get("/callback", async (c) => {
    const { ssoConfig, masterKey, appUrl, users, audit } = deps;
    if (!ssoConfig || !masterKey || !appUrl || !users || !audit) {
      return authErrorRedirect(c, "oidc");
    }
    const sealed = getCookie(c, OIDC_STATE_COOKIE);
    const stored = sealed ? await openState(masterKey, sealed) : null;
    const state = c.req.query("state");
    const code = c.req.query("code");
    deleteCookie(c, OIDC_STATE_COOKIE, { path: "/" });
    if (!stored || !state || !code || stored.state !== state) {
      return authErrorRedirect(c, "state");
    }
    // Advanced before each step so the catch below can name the one that broke
    // (GH #237). A mutable marker rather than a try/catch per call: it keeps the
    // happy path readable as the straight line it is, and every failure still
    // leaves the flow at exactly one place.
    let stage: CallbackStage = "sso_config";
    try {
      const sso = await ssoConfig.get();
      if (!sso) return authErrorRedirect(c, "oidc");
      stage = "discovery";
      const endpoints = await oidc.discover(sso.issuer);
      stage = "token_exchange";
      const { idToken } = await oidc.exchangeCode({
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: sso.clientId,
        clientSecret: sso.clientSecret,
        code,
        redirectUri: `${appUrl}/api/auth/callback`,
        verifier: stored.verifier,
      });
      stage = "id_token";
      const verify = oidc.createVerifier({
        jwksUri: endpoints.jwksUri,
        issuer: sso.issuer,
        clientId: sso.clientId,
      });
      const { email } = await verify(idToken);
      stage = "user_lookup";
      let user = await users.findByEmail(email);
      if (user && !user.active) {
        await audit.record({ actor: email, action: "login.denied_archived" });
        return authErrorRedirect(c, "account_archived");
      }
      if (!user) {
        // JIT provisioning: first SSO login creates the app-side row.
        stage = "user_provision";
        const displayName = email.split("@")[0] ?? email;
        user = await users.create({ email, displayName });
        await audit.record({ actor: email, action: "user.jit_created" });
      }
      stage = "session";
      const ttl = deps.sessionTtlHours ?? 12;
      const { token } = await deps.sessions.create(user.id, ttl);
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        path: "/",
        sameSite: "Lax",
        secure: cookieSecure(c),
        maxAge: ttl * 3600,
      });
      await audit.record({
        actor: email,
        action: "login.success",
        ip: clientIp(c, trustedProxyHops),
      });
      return c.redirect("/");
    } catch (error) {
      const failure = errorFields(error);
      // Written BEFORE the audit row on purpose: when the failure IS Postgres,
      // the row cannot be written and this line is the only trace the incident
      // leaves. It carries the ambient traceId from app.ts (GH #219), so the
      // `x-trace-id` the browser was handed on the failed redirect leads
      // straight to the stage that broke. `warn`, not `error`: an IdP outage or
      // a skewed clock is a real failure but not this server malfunctioning.
      log("warn", "oidc callback failed", { stage, ...failure });
      try {
        await audit.record({
          actor: "system",
          action: "login.failed",
          detail: { stage, ...failure },
        });
      } catch (auditError) {
        // A failed audit write must not become the response: the user is owed
        // the login-failed redirect either way, and letting this throw would
        // turn a diagnosable OIDC failure into a bare 500 from app.onError.
        log("error", "oidc callback audit write failed", errorFields(auditError));
      }
      return authErrorRedirect(c, callbackErrorCode(error));
    }
  });

  return router;
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
