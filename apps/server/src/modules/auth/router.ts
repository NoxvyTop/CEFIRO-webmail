import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bootstrapLoginSchema } from "@webmail/shared";
import type { AuditRepo } from "../../infra/repos/audit";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UsersRepo } from "../../infra/repos/users";
import type { Bootstrap } from "../setup/bootstrap";
import { errorResponse } from "../../core/error-response";
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

const BOOTSTRAP_ADMIN_EMAIL = "bootstrap-admin@webmail.local";

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
};

export function createAuthRouter(deps: AuthRouterDeps) {
  const router = new Hono<{ Variables: AuthVariables }>();
  const oidc = deps.oidcClient ?? defaultOidcClient;
  // One limiter per router instance, living in this closure so its counters
  // persist across requests. Injectable so tests can drive a small limit.
  const bootstrapRateLimiter =
    deps.rateLimiter ??
    createRateLimiter({ limit: BOOTSTRAP_LOGIN_MAX_ATTEMPTS, windowMs: BOOTSTRAP_LOGIN_WINDOW_MS });

  router.get("/me", requireSession(deps.sessions), (c) => c.json(c.get("user")));

  router.get("/mode", (c) => c.json({ bootstrapMode: deps.bootstrap?.enabled ?? false }));

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
      secure: appUrl.startsWith("https"),
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
    const { bootstrap, users, audit, appUrl } = deps;
    if (!bootstrap?.enabled || !users || !audit) {
      return errorResponse(c, "not_found", 404);
    }
    // Client IP for the rate gate and the audit row. This trusts the reverse
    // proxy's X-Forwarded-For — acceptable for a self-hosted deployment that
    // always sits behind a reverse proxy we control; a direct-to-app exposure
    // would need a hardened client-IP source. Absent header shares one bucket.
    const ip = c.req.header("x-forwarded-for");
    // Gate BEFORE parsing the body, verifying the password, or writing any
    // audit row: a flood is refused cheaply and — the point of GH #183 — a
    // blocked request produces ZERO `bootstrap.login_failed` rows.
    const gate = bootstrapRateLimiter.check(ip ?? "unknown");
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
    } catch {
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
      secure: (appUrl ?? "").startsWith("https"),
      maxAge: ttl * 3600,
    });
    await audit.record({ actor: BOOTSTRAP_ADMIN_EMAIL, action: "bootstrap.login", ip });
    return c.json({ ok: true });
  });

  router.get("/callback", async (c) => {
    const { ssoConfig, masterKey, appUrl, users, audit } = deps;
    if (!ssoConfig || !masterKey || !appUrl || !users || !audit) {
      return c.redirect("/?auth_error=oidc");
    }
    const sealed = getCookie(c, OIDC_STATE_COOKIE);
    const stored = sealed ? await openState(masterKey, sealed) : null;
    const state = c.req.query("state");
    const code = c.req.query("code");
    deleteCookie(c, OIDC_STATE_COOKIE, { path: "/" });
    if (!stored || !state || !code || stored.state !== state) {
      return c.redirect("/?auth_error=state");
    }
    try {
      const sso = await ssoConfig.get();
      if (!sso) return c.redirect("/?auth_error=oidc");
      const endpoints = await oidc.discover(sso.issuer);
      const { idToken } = await oidc.exchangeCode({
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: sso.clientId,
        clientSecret: sso.clientSecret,
        code,
        redirectUri: `${appUrl}/api/auth/callback`,
        verifier: stored.verifier,
      });
      const verify = oidc.createVerifier({
        jwksUri: endpoints.jwksUri,
        issuer: sso.issuer,
        clientId: sso.clientId,
      });
      const { email } = await verify(idToken);
      let user = await users.findByEmail(email);
      if (user && !user.active) {
        await audit.record({ actor: email, action: "login.denied_archived" });
        return c.redirect("/?auth_error=account_archived");
      }
      if (!user) {
        // JIT provisioning: first SSO login creates the app-side row.
        const displayName = email.split("@")[0] ?? email;
        user = await users.create({ email, displayName });
        await audit.record({ actor: email, action: "user.jit_created" });
      }
      const ttl = deps.sessionTtlHours ?? 12;
      const { token } = await deps.sessions.create(user.id, ttl);
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        path: "/",
        sameSite: "Lax",
        secure: appUrl.startsWith("https"),
        maxAge: ttl * 3600,
      });
      await audit.record({
        actor: email,
        action: "login.success",
        ip: c.req.header("x-forwarded-for"),
      });
      return c.redirect("/");
    } catch {
      await audit.record({ actor: "system", action: "login.failed" });
      return c.redirect("/?auth_error=oidc");
    }
  });

  return router;
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
