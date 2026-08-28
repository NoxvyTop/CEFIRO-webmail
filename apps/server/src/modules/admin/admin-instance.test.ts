import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createAuditRepo } from "../../infra/repos/audit";
import { createSsoConfigRepo } from "../../infra/repos/sso-config";
import { createInstanceSettingsRepo } from "../../infra/repos/instance-settings";
import { importMasterKey } from "../credentials/crypto";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createSessionStore } from "../auth/sessions";
import { createAdminRouter } from "./router";

const sql = createDb(testDatabaseUrl());
const sessions = createSessionStore(sql);
const users = createUsersRepo(sql);
const audit = createAuditRepo(sql);
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let ssoConfig: ReturnType<typeof createSsoConfigRepo>;
let instanceSettings: ReturnType<typeof createInstanceSettingsRepo>;
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
  // instance_settings is a singleton row (id = 1) shared with other suites
  // (instance-settings repo tests) against the same persistent database.
  // Reset it so "before any config" reflects the default-off state.
  await sql`update instance_settings set sent_with_footer_enabled = false where id = 1`;
  const masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, masterKey);
  ssoConfig = createSsoConfigRepo(sql, masterKey);
  instanceSettings = createInstanceSettingsRepo(sql);
  app = createApp({
    adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig, instanceSettings }),
    instanceSettings,
  });
});
afterAll(() => sql.end());

describe("admin instance settings api", () => {
  it("GET /instance: 401 without session, 403 for employee", async () => {
    const noSession = await app.request("/api/admin/instance");
    expect(noSession.status).toBe(401);

    const employee = await createEmployee();
    const forbidden = await app.request("/api/admin/instance", {
      headers: { cookie: `session=${employee.token}` },
    });
    expect(forbidden.status).toBe(403);
  });

  it("GET /instance: defaults to sentWithFooter:false", async () => {
    const admin = await createAdmin();
    const res = await app.request("/api/admin/instance", {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sentWithFooter: boolean };
    expect(body.sentWithFooter).toBe(false);
  });

  it("PUT /instance: as admin updates the flag, records an audit entry, and GET reflects it; invalid body 400", async () => {
    const admin = await createAdmin();

    const put = await app.request("/api/admin/instance", {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sentWithFooter: true }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { sentWithFooter: boolean };
    expect(putBody.sentWithFooter).toBe(true);

    const get = await app.request("/api/admin/instance", {
      headers: { cookie: `session=${admin.token}` },
    });
    const body = (await get.json()) as { sentWithFooter: boolean };
    expect(body.sentWithFooter).toBe(true);

    const auditRows = await sql<{ action: string; actor: string }[]>`
      select action, actor from audit_log where action = 'instance_settings.update' order by created_at desc limit 1
    `;
    expect(auditRows[0]?.actor).toBe(admin.user.email);

    const invalid = await app.request("/api/admin/instance", {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sentWithFooter: "not-a-boolean" }),
    });
    expect(invalid.status).toBe(400);

    const malformed = await app.request("/api/admin/instance", {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);

    // Reset for any suite that depends on the default-off state.
    await instanceSettings.set({ sentWithFooterEnabled: false });
  });

  it("PUT /instance: 401 without session, 403 for employee", async () => {
    const noSession = await app.request("/api/admin/instance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sentWithFooter: true }),
    });
    expect(noSession.status).toBe(401);

    const employee = await createEmployee();
    const forbidden = await app.request("/api/admin/instance", {
      method: "PUT",
      headers: { cookie: `session=${employee.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sentWithFooter: true }),
    });
    expect(forbidden.status).toBe(403);
  });
});

describe("public instance settings api", () => {
  it("GET /api/instance: returns the flag without auth", async () => {
    await instanceSettings.set({ sentWithFooterEnabled: false });
    const res = await app.request("/api/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sentWithFooter: boolean };
    expect(body.sentWithFooter).toBe(false);

    await instanceSettings.set({ sentWithFooterEnabled: true });
    const res2 = await app.request("/api/instance");
    const body2 = (await res2.json()) as { sentWithFooter: boolean };
    expect(body2.sentWithFooter).toBe(true);

    await instanceSettings.set({ sentWithFooterEnabled: false });
  });
});
