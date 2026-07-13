import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createAuditRepo } from "../../infra/repos/audit";
import { createSsoConfigRepo } from "../../infra/repos/sso-config";
import { importMasterKey } from "../credentials/crypto";
import { createApp } from "../../app";
import { createSessionStore } from "../auth/sessions";
import { createAdminRouter } from "./router";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const sessions = createSessionStore(sql);
const users = createUsersRepo(sql);
const audit = createAuditRepo(sql);
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let ssoConfig: ReturnType<typeof createSsoConfigRepo>;
let app: ReturnType<typeof createApp>;

async function createAdmin() {
  const u = await users.create({
    email: `admin-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Admin",
    role: "admin",
  });
  const { token } = await sessions.create(u.id, 1);
  return { user: u, token };
}

async function createEmployee() {
  const u = await users.create({
    email: `emp-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Employee",
  });
  const { token } = await sessions.create(u.id, 1);
  return { user: u, token };
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  // sso_config is a singleton row (id = 1) shared with other suites (setup, login-flow,
  // jit-provisioning, sso-config repo tests) against the same persistent database.
  // Clear it so "before any config" reflects a deterministic unconfigured state.
  await sql`delete from sso_config where id = 1`;
  const masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, masterKey);
  ssoConfig = createSsoConfigRepo(sql, masterKey);
  app = createApp({
    adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig }),
  });
});
afterAll(() => sql.end());

describe("admin sso config api", () => {
  it("GET /sso: 401 without session, 403 for employee", async () => {
    const noSession = await app.request("/api/admin/sso");
    expect(noSession.status).toBe(401);

    const employee = await createEmployee();
    const forbidden = await app.request("/api/admin/sso", {
      headers: { cookie: `session=${employee.token}` },
    });
    expect(forbidden.status).toBe(403);
  });

  it("GET /sso: before any config returns configured:false", async () => {
    const admin = await createAdmin();
    const res = await app.request("/api/admin/sso", {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      issuer: string | null;
      clientId: string | null;
      scopes: string | null;
    };
    expect(body.configured).toBe(false);
    expect(body.issuer).toBeNull();
    expect(body.clientId).toBeNull();
    expect(body.scopes).toBeNull();
  });

  it("PUT /sso: sets config, GET reflects it without leaking the secret, invalid body 400", async () => {
    const admin = await createAdmin();

    const put = await app.request("/api/admin/sso", {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        issuer: "https://auth.test",
        clientId: "webmail",
        clientSecret: "s",
        scopes: "openid email",
      }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { ok: boolean };
    expect(putBody.ok).toBe(true);

    const get = await app.request("/api/admin/sso", {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.issuer).toBe("https://auth.test");
    expect(body.clientId).toBe("webmail");
    expect(body.scopes).toBe("openid email");
    expect(JSON.stringify(body)).not.toContain("clientSecret");

    const invalid = await app.request("/api/admin/sso", {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ issuer: "not-a-url" }),
    });
    expect(invalid.status).toBe(400);

    const malformed = await app.request("/api/admin/sso", {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });
});
