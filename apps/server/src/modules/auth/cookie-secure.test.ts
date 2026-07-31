import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import { createAuthRouter, type OidcClient } from "./router";
import { createBootstrap } from "../setup/bootstrap";
import { importMasterKey } from "../credentials/crypto";
import type { AuditRepo } from "../../infra/repos/audit";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UserRecord, UsersRepo } from "../../infra/repos/users";
import type { SessionStore } from "./sessions";

// In-memory doubles (no DB): GH #196 is a pure cookie-attribute concern, so
// this suite drives the login state cookie and the bootstrap session cookie
// through the router with fakes and reads back the Set-Cookie attributes.

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

async function makeApp(opts: { isProduction: boolean; appUrl: string }) {
  const masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  const boot = createBootstrap(true);
  const app = createApp({
    authRouter: createAuthRouter({
      sessions: fakeSessions(),
      users: fakeUsers(),
      audit: fakeAudit(),
      ssoConfig: fakeSsoConfig(),
      masterKey,
      appUrl: opts.appUrl,
      sessionTtlHours: 1,
      bootstrap: boot,
      oidcClient: stubOidc,
      isProduction: opts.isProduction,
    }),
  });
  return { app, boot };
}

function setCookieLine(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

describe("Secure cookies in production (GH #196)", () => {
  it("forces Secure on the OIDC-state cookie in production even when APP_URL is http", async () => {
    const { app } = await makeApp({ isProduction: true, appUrl: "http://localhost:5173" });
    const res = await app.request("/api/auth/login");
    const line = setCookieLine(res, "oidc_state");
    expect(line).toBeDefined();
    expect(line!).toMatch(/;\s*Secure/i);
  });

  it("forces Secure on the session cookie in production even when APP_URL is http", async () => {
    const { app, boot } = await makeApp({ isProduction: true, appUrl: "http://localhost:5173" });
    const res = await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bootstrap-admin", password: boot.password }),
    });
    const line = setCookieLine(res, "session");
    expect(line).toBeDefined();
    expect(line!).toMatch(/;\s*Secure/i);
  });

  it("does not force Secure over http outside production (local dev keeps working)", async () => {
    const { app } = await makeApp({ isProduction: false, appUrl: "http://localhost:5173" });
    const res = await app.request("/api/auth/login");
    const line = setCookieLine(res, "oidc_state");
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/;\s*Secure/i);
  });

  it("still honors an https APP_URL outside production", async () => {
    const { app } = await makeApp({ isProduction: false, appUrl: "https://mail.noxvytop.com" });
    const res = await app.request("/api/auth/login");
    const line = setCookieLine(res, "oidc_state");
    expect(line).toBeDefined();
    expect(line!).toMatch(/;\s*Secure/i);
  });
});
