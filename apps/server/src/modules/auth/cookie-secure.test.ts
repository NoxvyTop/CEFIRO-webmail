import { describe, expect, it, vi } from "vitest";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createAuthRouter, type OidcClient } from "./router";
import { createBootstrap } from "../setup/bootstrap";
import { importMasterKey } from "../credentials/crypto";
import type { AuditRepo } from "../../infra/repos/audit";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UserRecord, UsersRepo } from "../../infra/repos/users";
import type { SessionStore } from "./sessions";

// In-memory doubles (no DB): the cookie `Secure` attribute (GH #288) is a pure
// per-request concern, so this suite drives the login state cookie and the
// bootstrap session cookie through the router with fakes and reads back the
// Set-Cookie attributes. `Secure` is now derived from the scheme the client
// used to reach the edge — X-Forwarded-Proto behind a trusted proxy, or the
// direct request scheme — not from NODE_ENV.

const stubOidc: OidcClient = {
  discover: async () => ({
    authorizationEndpoint: "https://auth.test/authorize",
    tokenEndpoint: "https://auth.test/token",
    jwksUri: "https://auth.test/jwks",
  }),
  exchangeCode: async () => ({ idToken: "stub" }),
  createVerifier: () => async () => ({ email: "user@noxvytop.com" }),
};

function fakeSsoConfig(): SsoConfigRepo {
  return {
    get: async () => ({
      issuer: "https://auth.test",
      clientId: "webmail",
      clientSecret: "s",
      scopes: "openid email",
    }),
  } as unknown as SsoConfigRepo;
}

function fakeUsers(): UsersRepo {
  const admin: UserRecord = {
    id: "admin-1",
    email: "bootstrap-admin@webmail.local",
    displayName: "Bootstrap Admin",
    role: "admin",
    locale: "es",
    active: true,
  };
  return {
    findByEmail: async () => admin,
    create: async () => admin,
    setActive: async () => admin,
    setRole: async () => admin,
  } as unknown as UsersRepo;
}

function fakeSessions(): SessionStore {
  return {
    create: async () => ({ token: "session-token", expiresAt: new Date() }),
  } as unknown as SessionStore;
}

function fakeAudit(): AuditRepo {
  return { record: vi.fn(async () => {}) } as unknown as AuditRepo;
}

async function makeApp(opts: { trustedProxyHops?: number; appUrl?: string } = {}) {
  const masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  // Operator-set break-glass credential (GH #235): the process no longer mints
  // one, so a bootstrap that is meant to be enabled has to be handed a secret.
  const boot = createBootstrap(true, "test-bootstrap-secret-0123456789");
  const app = createApp({
    authRouter: createAuthRouter({
      sessions: fakeSessions(),
      users: fakeUsers(),
      audit: fakeAudit(),
      ssoConfig: fakeSsoConfig(),
      masterKey,
      appUrl: opts.appUrl ?? "https://mail.noxvytop.com",
      sessionTtlHours: 1,
      bootstrap: boot,
      oidcClient: stubOidc,
      trustedProxyHops: opts.trustedProxyHops,
    }),
  });
  return { app, boot };
}

function setCookieLine(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

async function loginStateCookie(res: Response): Promise<string> {
  const line = setCookieLine(res, "oidc_state");
  expect(line).toBeDefined();
  return line!;
}

describe("Secure cookies from the effective request scheme (GH #288)", () => {
  it("marks the OIDC-state cookie Secure behind a trusted X-Forwarded-Proto: https edge", async () => {
    const { app } = await makeApp({ trustedProxyHops: 1 });
    const res = await app.request("/api/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(await loginStateCookie(res)).toMatch(/;\s*Secure/i);
  });

  it("does not mark the OIDC-state cookie Secure behind a trusted X-Forwarded-Proto: http edge", async () => {
    // The fix this issue is about: a plain-HTTP edge must NOT get a Secure state
    // cookie, or the browser drops it and OIDC login can never complete.
    const { app } = await makeApp({ trustedProxyHops: 1 });
    const res = await app.request("/api/auth/login", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(await loginStateCookie(res)).not.toMatch(/;\s*Secure/i);
  });

  it("marks the session cookie Secure behind a trusted X-Forwarded-Proto: https edge", async () => {
    const { app, boot } = await makeApp({ trustedProxyHops: 1 });
    const res = await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ email: "bootstrap-admin", password: boot.password }),
    });
    const line = setCookieLine(res, "session");
    expect(line).toBeDefined();
    expect(line!).toMatch(/;\s*Secure/i);
  });

  it("does not mark the session cookie Secure behind a trusted X-Forwarded-Proto: http edge", async () => {
    const { app, boot } = await makeApp({ trustedProxyHops: 1 });
    const res = await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "http" },
      body: JSON.stringify({ email: "bootstrap-admin", password: boot.password }),
    });
    const line = setCookieLine(res, "session");
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/;\s*Secure/i);
  });

  it("reads the edge hop of an X-Forwarded-Proto chain, not the inner one", async () => {
    // Two trusted proxies, so the leftmost trusted entry is what the browser
    // sent to the edge (https), even though the inner hop was plain http. Same
    // right-to-left attribution rule core/client-ip.ts uses for the client IP.
    const { app } = await makeApp({ trustedProxyHops: 2 });
    const res = await app.request("/api/auth/login", {
      headers: { "x-forwarded-proto": "https, http" },
    });
    expect(await loginStateCookie(res)).toMatch(/;\s*Secure/i);
  });

  // GH #334: nginx and Cloudflare SET X-Forwarded-Proto (they do not append to
  // it the way X-Forwarded-For accumulates), so the documented two-hop topology
  // arrives with a ONE-entry chain. Counting two hops from the right used to
  // land on index -1 and drop through to the container's own http socket, which
  // is how a production session cookie went out without `Secure`.
  it("marks Secure on a single-value X-Forwarded-Proto: https with hops=2", async () => {
    const { app } = await makeApp({ trustedProxyHops: 2 });
    const res = await app.request("/api/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(await loginStateCookie(res)).toMatch(/;\s*Secure/i);
  });

  it("does not mark Secure on a single-value X-Forwarded-Proto: http with hops=2", async () => {
    const { app } = await makeApp({ trustedProxyHops: 2, appUrl: "http://localhost:5173" });
    const res = await app.request("http://localhost:5173/api/auth/login", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(await loginStateCookie(res)).not.toMatch(/;\s*Secure/i);
  });

  it("falls back to the socket scheme when a trusted-proxy deployment sends no header", async () => {
    // The short-chain rule only rescues a header that IS there. With none at
    // all nothing described the client's leg, so the socket stays authoritative.
    const { app } = await makeApp({ trustedProxyHops: 2, appUrl: "http://localhost:5173" });
    const res = await app.request("http://localhost:5173/api/auth/login");
    expect(await loginStateCookie(res)).not.toMatch(/;\s*Secure/i);
  });

  it("falls back to the direct scheme and marks Secure on a direct https request", async () => {
    // No trusted proxy, so X-Forwarded-Proto is ignored and the socket scheme
    // this process terminates on is authoritative.
    const { app } = await makeApp({ trustedProxyHops: 0 });
    const res = await app.request("https://mail.noxvytop.com/api/auth/login");
    expect(await loginStateCookie(res)).toMatch(/;\s*Secure/i);
  });

  it("falls back to the direct scheme and does not mark Secure on a direct http request", async () => {
    const { app } = await makeApp({ trustedProxyHops: 0, appUrl: "http://localhost:5173" });
    const res = await app.request("http://localhost:5173/api/auth/login");
    expect(await loginStateCookie(res)).not.toMatch(/;\s*Secure/i);
  });

  it("ignores X-Forwarded-Proto when no proxy hop is trusted", async () => {
    // A spoofed header must not flip Secure on when the operator declared no
    // trusted proxy: the direct http scheme wins.
    const { app } = await makeApp({ trustedProxyHops: 0, appUrl: "http://localhost:5173" });
    const res = await app.request("http://localhost:5173/api/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(await loginStateCookie(res)).not.toMatch(/;\s*Secure/i);
  });
});
