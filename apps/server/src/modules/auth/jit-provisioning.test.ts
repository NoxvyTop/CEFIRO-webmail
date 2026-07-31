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
let currentEmail: string;

const stubOidc: OidcClient = {
  discover: async () => ({
    authorizationEndpoint: "https://auth.test/authorize",
    tokenEndpoint: "https://auth.test/token",
    jwksUri: "https://auth.test/jwks",
  }),
  exchangeCode: async () => ({ idToken: "stub-id-token" }),
  createVerifier: () => async () => ({ email: currentEmail }),
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

async function runCallback(): Promise<Response> {
  const login = await app.request("/api/auth/login");
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const sealed = cookieValue(login, "oidc_state")!;
  return app.request(`/api/auth/callback?code=abc&state=${state}`, {
    headers: { cookie: `oidc_state=${sealed}` },
  });
}

async function runLoginFlow(): Promise<{ session: string | null; response: Response }> {
  const cb = await runCallback();
  return { session: cookieValue(cb, "session"), response: cb };
}

describe("jit provisioning", () => {
  it("creates the user on first login (JIT) and issues a session", async () => {
    currentEmail = `jit-${crypto.randomUUID()}@noxvytop.com`;
    const { session, response } = await runLoginFlow();
    expect(response.headers.get("location")).toBe("/");
    expect(session).toBeTruthy();

    const created = await createUsersRepo(sql).findByEmail(currentEmail);
    expect(created).not.toBeNull();
    expect(created!.displayName).toBe(currentEmail.split("@")[0]);
    expect(created!.active).toBe(true);

    const me = await app.request("/api/auth/me", {
      headers: { cookie: `session=${session}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(currentEmail);
  });

  it("reuses the existing row on subsequent logins (no duplicate)", async () => {
    currentEmail = `reuse-${crypto.randomUUID()}@noxvytop.com`;
    await createUsersRepo(sql).create({ email: currentEmail, displayName: "Existing" });
    const before = (await createUsersRepo(sql).list()).filter(
      (u) => u.email === currentEmail,
    ).length;

    const { session } = await runLoginFlow();
    expect(session).toBeTruthy();

    const after = (await createUsersRepo(sql).list()).filter(
      (u) => u.email === currentEmail,
    ).length;
    expect(after).toBe(before);
    expect(after).toBe(1);
  });

  it("refuses login for an archived user", async () => {
    currentEmail = `arch-${crypto.randomUUID()}@noxvytop.com`;
    const u = await createUsersRepo(sql).create({ email: currentEmail, displayName: "Arch" });
    await createUsersRepo(sql).setActive(u.id, false);

    const cb = await runCallback();
    expect(cb.headers.get("location")).toBe("/?auth_error=account_archived");
    expect(cookieValue(cb, "session")).toBeNull();
  });
});
