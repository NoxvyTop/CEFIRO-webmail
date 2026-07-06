import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuditRepo } from "../../infra/repos/audit";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UsersRepo } from "../../infra/repos/users";
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
};

export function createAuthRouter(deps: AuthRouterDeps) {
  const router = new Hono<{ Variables: AuthVariables }>();
  const oidc = deps.oidcClient ?? defaultOidcClient;

  router.get("/me", requireSession(deps.sessions), (c) => c.json(c.get("user")));

  router.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deps.sessions.revoke(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  router.get("/login", async (c) => {
    const { ssoConfig, masterKey, appUrl } = deps;
    if (!ssoConfig || !masterKey || !appUrl) {
      return c.json(
        { code: "sso_not_configured", message: "errors.sso_not_configured", traceId: c.get("traceId") },
        503,
      );
    }
    const sso = await ssoConfig.get();
    if (!sso) {
      return c.json(
        { code: "sso_not_configured", message: "errors.sso_not_configured", traceId: c.get("traceId") },
        503,
      );
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
      const user = await users.findByEmail(email);
      if (!user) {
        await audit.record({ actor: "system", action: "login.denied", detail: { email } });
        return c.redirect("/?auth_error=unknown_user");
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
