import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createAuditRepo } from "../../infra/repos/audit";
import { createSsoConfigRepo } from "../../infra/repos/sso-config";
import { createInstanceSettingsRepo } from "../../infra/repos/instance-settings";
import { importMasterKey } from "../credentials/crypto";
import { createApp } from "../../app";
import { createSessionStore } from "../auth/sessions";
import { createAuthRouter } from "../auth/router";
import { createAdminRouter } from "./router";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
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
  const masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, masterKey);
  ssoConfig = createSsoConfigRepo(sql, masterKey);
  instanceSettings = createInstanceSettingsRepo(sql);
  app = createApp({
    authRouter: createAuthRouter({ sessions }),
    adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig, instanceSettings }),
  });
});
afterAll(() => sql.end());

describe("admin users api", () => {
  it("GET /users: 401 without session, 403 for employee, 200 with mailboxLinked for admin", async () => {
    const noSession = await app.request("/api/admin/users");
    expect(noSession.status).toBe(401);

    const employee = await createEmployee();
    const forbidden = await app.request("/api/admin/users", {
      headers: { cookie: `session=${employee.token}` },
    });
    expect(forbidden.status).toBe(403);

    const admin = await createAdmin();
    const linked = await users.create({
      email: `linked-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Linked",
    });
    await mailCredentials.set(linked.id, "mailbox-pass-123");

    const res = await app.request("/api/admin/users", {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; mailboxLinked: boolean }>;
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((u) => u.id === linked.id);
    expect(found?.mailboxLinked).toBe(true);
    const foundAdmin = body.find((u) => u.id === admin.user.id);
    expect(foundAdmin?.mailboxLinked).toBe(false);
  });

  // GH #130: the admin users list must carry each user's uploaded avatar
  // (users.avatar_data_url) so the console can render it instead of always
  // falling back to initials.
  it("GET /users: includes avatarDataUrl (null by default, populated once the user sets one)", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `avatar-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Avatar Target",
    });

    const before = await app.request("/api/admin/users", {
      headers: { cookie: `session=${admin.token}` },
    });
    const beforeBody = (await before.json()) as Array<{ id: string; avatarDataUrl: string | null }>;
    expect(beforeBody.find((u) => u.id === target.id)?.avatarDataUrl).toBeNull();

    await users.setAvatar(target.id, "data:image/png;base64,aGVsbG8=");

    const after = await app.request("/api/admin/users", {
      headers: { cookie: `session=${admin.token}` },
    });
    const afterBody = (await after.json()) as Array<{ id: string; avatarDataUrl: string | null }>;
    expect(afterBody.find((u) => u.id === target.id)?.avatarDataUrl).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
  });

  it("POST /users: creates user with credential, hides password, rejects duplicates and invalid body", async () => {
    const admin = await createAdmin();
    const email = `new-${crypto.randomUUID()}@noxvytop.com`;

    const res = await app.request("/api/admin/users", {
      method: "POST",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ email, displayName: "New User", mailPassword: "mailbox-pass-123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBe(email);
    expect(JSON.stringify(body)).not.toContain("mailbox-pass-123");
    expect(await mailCredentials.get(body.id as string)).toBe("mailbox-pass-123");

    const dup = await app.request("/api/admin/users", {
      method: "POST",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ email, displayName: "Dup", mailPassword: "mailbox-pass-123" }),
    });
    expect(dup.status).toBe(409);

    const invalid = await app.request("/api/admin/users", {
      method: "POST",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", displayName: "" }),
    });
    expect(invalid.status).toBe(400);

    const malformed = await app.request("/api/admin/users", {
      method: "POST",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("PUT /users/:id/role: updates role, 404 for missing id", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `role-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Role Target",
    });

    const res = await app.request(`/api/admin/users/${target.id}/role`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("admin");

    const missing = await app.request(`/api/admin/users/${crypto.randomUUID()}/role`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(missing.status).toBe(404);
  });

  it("PUT /users/:id/active: archiving revokes sessions (blocking /api/auth/me), reactivating restores access", async () => {
    const admin = await createAdmin();
    const target = await createEmployee();

    const meBefore = await app.request("/api/auth/me", {
      headers: { cookie: `session=${target.token}` },
    });
    expect(meBefore.status).toBe(200);

    const archived = await app.request(`/api/admin/users/${target.user.id}/active`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(archived.status).toBe(200);
    const archivedBody = (await archived.json()) as { active: boolean };
    expect(archivedBody.active).toBe(false);

    const meAfter = await app.request("/api/auth/me", {
      headers: { cookie: `session=${target.token}` },
    });
    expect(meAfter.status).toBe(401);

    const reactivated = await app.request(`/api/admin/users/${target.user.id}/active`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    expect(reactivated.status).toBe(200);
    const reactivatedBody = (await reactivated.json()) as { active: boolean };
    expect(reactivatedBody.active).toBe(true);
  });

  it("PUT /users/:id/role: blocks an admin from demoting themselves", async () => {
    const admin = await createAdmin();

    const res = await app.request(`/api/admin/users/${admin.user.id}/role`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "employee" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("self_demotion");

    // Role must be unchanged.
    const reload = await app.request("/api/admin/users", {
      headers: { cookie: `session=${admin.token}` },
    });
    const list = (await reload.json()) as Array<{ id: string; role: string }>;
    expect(list.find((u) => u.id === admin.user.id)?.role).toBe("admin");
  });

  it("PUT /users/:id/role: demotes another admin when other admins remain", async () => {
    const actor = await createAdmin();
    const other = await createAdmin();

    const res = await app.request(`/api/admin/users/${other.user.id}/role`, {
      method: "PUT",
      headers: { cookie: `session=${actor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "employee" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("employee");
  });

  it("PUT /users/:id/active: blocks an admin from archiving themselves", async () => {
    const admin = await createAdmin();

    const res = await app.request(`/api/admin/users/${admin.user.id}/active`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("self_archive");

    // Session must still be valid (not archived).
    const me = await app.request("/api/auth/me", {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(me.status).toBe(200);
  });

  it("PUT /users/:id/credential: sets credential, 404 for missing id", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `cred-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Cred Target",
    });

    const res = await app.request(`/api/admin/users/${target.id}/credential`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ mailPassword: "new-mailbox-pass" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("new-mailbox-pass");
    expect(await mailCredentials.get(target.id)).toBe("new-mailbox-pass");

    const missing = await app.request(`/api/admin/users/${crypto.randomUUID()}/credential`, {
      method: "PUT",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ mailPassword: "new-mailbox-pass" }),
    });
    expect(missing.status).toBe(404);
  });
});
