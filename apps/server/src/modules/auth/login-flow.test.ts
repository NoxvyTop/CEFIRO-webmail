import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createAuditRepo } from "../../infra/repos/audit";
import { createSsoConfigRepo } from "../../infra/repos/sso-config";
import { importMasterKey } from "../credentials/crypto";
import { createApp } from "../../app";
import { createAuthRouter, type OidcClient } from "./router";
import { createSessionStore } from "./sessions";

const sql = createDb(testDatabaseUrl());

const keyB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
let app: ReturnType<typeof createApp>;
let email: string;

const stubOidc: OidcClient = {
  discover: async () => ({
    authorizationEndpoint: "https://auth.test/authorize",
    tokenEndpoint: "https://auth.test/token",
    jwksUri: "https://auth.test/jwks",
  }),
  exchangeCode: async () => ({ idToken: "stub-id-token" }),
  createVerifier: () => async () => ({ email }),
};

function cookieValue(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    if (line.startsWith(`${name}=`)) return line.split(";")[0]!.slice(name.length + 1);
  }
  return null;
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const masterKey = await importMasterKey(keyB64);
  email = `login-${crypto.randomUUID()}@noxvytop.com`;
  await createUsersRepo(sql).create({ email, displayName: "Login User" });
  await createSsoConfigRepo(sql, masterKey).set({
    issuer: "https://auth.test",
    clientId: "webmail",
    clientSecret: "s",
    scopes: "openid email",
  });
  app = createApp({
    authRouter: createAuthRouter({
      sessions: createSessionStore(sql),
      users: createUsersRepo(sql),
      audit: createAuditRepo(sql),
      ssoConfig: createSsoConfigRepo(sql, masterKey),
      masterKey,
      appUrl: "http://localhost:5173",
      sessionTtlHours: 1,
      oidcClient: stubOidc,
    }),
  });
});
afterAll(() => sql.end());

describe("oidc login flow", () => {
  it("redirects to the provider with state cookie", async () => {
    const res = await app.request("/api/auth/login");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://auth.test/authorize");
    expect(cookieValue(res, "oidc_state")).toBeTruthy();
  });

  it("completes callback: session cookie, /me works", async () => {
    const login = await app.request("/api/auth/login");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const sealed = cookieValue(login, "oidc_state")!;

    const cb = await app.request(
      `/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `oidc_state=${sealed}` } },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/");
    const session = cookieValue(cb, "session")!;
    expect(session).toBeTruthy();

    const me = await app.request("/api/auth/me", {
      headers: { cookie: `session=${session}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(email);
  });

  it("rejects a state mismatch", async () => {
    const login = await app.request("/api/auth/login");
    const sealed = cookieValue(login, "oidc_state")!;
    const cb = await app.request("/api/auth/callback?code=abc&state=wrong", {
      headers: { cookie: `oidc_state=${sealed}` },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?auth_error=state");
  });

  it("JIT-provisions unknown users instead of denying them", async () => {
    email = `unknown-${crypto.randomUUID()}@noxvytop.com`; // verifier stub now returns an email with no user
    const login = await app.request("/api/auth/login");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const sealed = cookieValue(login, "oidc_state")!;
    const cb = await app.request(
      `/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `oidc_state=${sealed}` } },
    );
    expect(cb.headers.get("location")).toBe("/");
    expect(cookieValue(cb, "session")).toBeTruthy();
    expect(await createUsersRepo(sql).findByEmail(email)).not.toBeNull();
  });
});
