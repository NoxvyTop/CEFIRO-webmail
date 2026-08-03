import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createApp } from "../../app";
import { createSessionStore } from "../auth/sessions";
import { createAuthRouter } from "../auth/router";
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

    // Server-side pagination (GH #153): target each user via the search param
    // so the assertion holds regardless of how many other users the shared DB
    // has accumulated (the user might otherwise fall on a later page).
    const res = await app.request(
      `/api/admin/users?search=${encodeURIComponent(linked.email)}`,
      { headers: { cookie: `session=${admin.token}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ id: string; mailboxLinked: boolean }>;
      total: number;
      stats: { total: number; active: number; mailboxLinked: number };
    };
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.find((u) => u.id === linked.id)?.mailboxLinked).toBe(true);

    const adminRes = await app.request(
      `/api/admin/users?search=${encodeURIComponent(admin.user.email)}`,
      { headers: { cookie: `session=${admin.token}` } },
    );
    const adminBody = (await adminRes.json()) as {
      users: Array<{ id: string; mailboxLinked: boolean }>;
    };
    expect(adminBody.users.find((u) => u.id === admin.user.id)?.mailboxLinked).toBe(false);
  });

  // GH #205: the admin users list no longer embeds the avatar as a base64 data
  // URL — it exposes a cacheable avatar URL (null when the user has no photo),
  // and the base64 bytes never travel in the list payload.
  it("GET /users: exposes avatarUrl (null by default, the avatar endpoint once the user sets one) and never embeds the base64", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `avatar-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Avatar Target",
    });

    const before = await app.request(
      `/api/admin/users?search=${encodeURIComponent(target.email)}`,
      { headers: { cookie: `session=${admin.token}` } },
    );
    const beforeBody = (await before.json()) as {
      users: Array<{ id: string; avatarUrl: string | null }>;
    };
    expect(beforeBody.users.find((u) => u.id === target.id)?.avatarUrl).toBeNull();

    await users.setAvatar(target.id, "data:image/png;base64,aGVsbG8=");

    const after = await app.request(
      `/api/admin/users?search=${encodeURIComponent(target.email)}`,
      { headers: { cookie: `session=${admin.token}` } },
    );
    const afterBody = (await after.json()) as {
      users: Array<{ id: string; avatarUrl: string | null }>;
    };
    expect(afterBody.users.find((u) => u.id === target.id)?.avatarUrl).toBe(
      `/api/admin/users/${target.id}/avatar`,
    );
    // The list payload must not carry the base64 avatar bytes anymore.
    expect(JSON.stringify(afterBody)).not.toContain("aGVsbG8=");
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

  it("POST /users: a duplicate that races the unique index returns 409, not 500 (GH #277)", async () => {
    const admin = await createAdmin();
    // A repo that passes the findByEmail pre-check (returns null) but whose
    // insert then loses the race to the unique index on users.email — exactly
    // the TOCTOU window two concurrent creates open. The raw 23505 used to
    // escape as 500 `internal`; it must now be the same 409 the pre-check gives.
    const racingUsers = {
      ...users,
      async findByEmail() {
        return null;
      },
      async create() {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
      },
    } as unknown as typeof users;
    const racingApp = createApp({
      adminRouter: createAdminRouter({
        sessions,
        users: racingUsers,
        mailCredentials,
        audit,
        ssoConfig,
        instanceSettings,
      }),
    });

    const res = await racingApp.request("/api/admin/users", {
      method: "POST",
      headers: { cookie: `session=${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ email: `race-${crypto.randomUUID()}@noxvytop.com`, displayName: "Race" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("user_exists");
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
    const reload = await app.request(
      `/api/admin/users?search=${encodeURIComponent(admin.user.email)}`,
      { headers: { cookie: `session=${admin.token}` } },
    );
    const list = (await reload.json()) as { users: Array<{ id: string; role: string }> };
    expect(list.users.find((u) => u.id === admin.user.id)?.role).toBe("admin");
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

// GH #153: GET /api/admin/users paginates server-side instead of returning
// every user (each row can embed a ~1 MiB base64 avatar).
type UsersPageBody = {
  users: Array<{ id: string; mailboxLinked: boolean }>;
  total: number;
  stats: { total: number; active: number; mailboxLinked: number };
};

describe("admin users pagination (GH #153)", () => {
  it("returns a bounded page, a filtered total, and tenant-wide stats", async () => {
    const admin = await createAdmin();
    // A unique token in each email isolates this test's users from everything
    // else in the shared DB, so the filtered total is exactly what we created.
    const token = crypto.randomUUID();
    for (let i = 0; i < 3; i++) {
      await users.create({
        email: `pg${i}-${token}@noxvytop.com`,
        displayName: `Pager ${i}`,
      });
    }
    const headers = { cookie: `session=${admin.token}` };

    const p1 = await app.request(`/api/admin/users?page=1&pageSize=2&search=${token}`, { headers });
    expect(p1.status).toBe(200);
    const b1 = (await p1.json()) as UsersPageBody;
    expect(b1.users).toHaveLength(2);
    expect(b1.total).toBe(3);
    // Stats are aggregate, so they count every user, not just this page.
    expect(b1.stats.total).toBeGreaterThanOrEqual(3);
    expect(typeof b1.stats.active).toBe("number");
    expect(typeof b1.stats.mailboxLinked).toBe("number");

    const p2 = await app.request(`/api/admin/users?page=2&pageSize=2&search=${token}`, { headers });
    const b2 = (await p2.json()) as UsersPageBody;
    expect(b2.users).toHaveLength(1);
    expect(b2.total).toBe(3);

    // A page past the end is empty but still reports the true total.
    const p3 = await app.request(`/api/admin/users?page=3&pageSize=2&search=${token}`, { headers });
    const b3 = (await p3.json()) as UsersPageBody;
    expect(b3.users).toHaveLength(0);
    expect(b3.total).toBe(3);
  });

  it("normalizes junk numeric params and rejects an over-long search", async () => {
    const admin = await createAdmin();
    const headers = { cookie: `session=${admin.token}` };

    // Non-numeric page/pageSize fall back to defaults rather than 400.
    const junk = await app.request("/api/admin/users?page=abc&pageSize=xyz", { headers });
    expect(junk.status).toBe(200);
    const junkBody = (await junk.json()) as UsersPageBody;
    expect(Array.isArray(junkBody.users)).toBe(true);

    // An absurdly long search term is a client bug → 400 invalid_query.
    const bad = await app.request(`/api/admin/users?search=${"a".repeat(201)}`, { headers });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("invalid_query");
  });

  it("resolves mailbox-linked state for the whole page in one batched query (no N+1)", async () => {
    const admin = await createAdmin();
    const token = crypto.randomUUID();
    const withCred = await users.create({
      email: `bat-a-${token}@noxvytop.com`,
      displayName: "Batch A",
    });
    const withoutCred = await users.create({
      email: `bat-b-${token}@noxvytop.com`,
      displayName: "Batch B",
    });
    await mailCredentials.set(withCred.id, "mailbox-pass-123");

    const batchSpy = vi.spyOn(mailCredentials, "existsForUsers");
    const perUserSpy = vi.spyOn(mailCredentials, "exists");

    const res = await app.request(`/api/admin/users?search=${token}&pageSize=100`, {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsersPageBody;

    // Exactly one batched credential lookup for the page, never the per-user one.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(perUserSpy).not.toHaveBeenCalled();
    expect(body.users.find((u) => u.id === withCred.id)?.mailboxLinked).toBe(true);
    expect(body.users.find((u) => u.id === withoutCred.id)?.mailboxLinked).toBe(false);

    batchSpy.mockRestore();
    perUserSpy.mockRestore();
  });

  it("moves aggregate stats when a linked, active user is added", async () => {
    const admin = await createAdmin();
    const headers = { cookie: `session=${admin.token}` };

    const before = ((await (
      await app.request("/api/admin/users?pageSize=1", { headers })
    ).json()) as UsersPageBody).stats;

    const u = await users.create({
      email: `stat-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Stat",
    });
    await mailCredentials.set(u.id, "mailbox-pass-123");

    const after = ((await (
      await app.request("/api/admin/users?pageSize=1", { headers })
    ).json()) as UsersPageBody).stats;

    expect(after.total).toBe(before.total + 1);
    expect(after.active).toBe(before.active + 1);
    expect(after.mailboxLinked).toBe(before.mailboxLinked + 1);
  });
});

// GH #205: the avatar is served as a cacheable resource by URL instead of
// being embedded in the users list. Admin-only (any user's photo), with an
// ETag/Cache-Control and a 304 on If-None-Match.
describe("admin avatar endpoint (GH #205)", () => {
  // base64("hello") — the endpoint serves whatever bytes are stored; it does
  // not re-validate the image structure (the upload path already did).
  const AVATAR_DATA_URL = "data:image/png;base64,aGVsbG8=";

  it("401 without a session, 403 for an employee", async () => {
    const target = await users.create({
      email: `av-authz-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Authz",
    });
    await users.setAvatar(target.id, AVATAR_DATA_URL);

    const noSession = await app.request(`/api/admin/users/${target.id}/avatar`);
    expect(noSession.status).toBe(401);

    const employee = await createEmployee();
    const forbidden = await app.request(`/api/admin/users/${target.id}/avatar`, {
      headers: { cookie: `session=${employee.token}` },
    });
    expect(forbidden.status).toBe(403);
  });

  it("404 when the user has no avatar", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `av-none-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "No Photo",
    });
    const res = await app.request(`/api/admin/users/${target.id}/avatar`, {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("200 returns the image bytes with content-type, a strong ETag and Cache-Control", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `av-ok-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Has Photo",
    });
    await users.setAvatar(target.id, AVATAR_DATA_URL);

    const res = await app.request(`/api/admin/users/${target.id}/avatar`, {
      headers: { cookie: `session=${admin.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers.get("cache-control")).toContain("must-revalidate");
    expect(await res.text()).toBe("hello");
  });

  it("304 when If-None-Match matches the current ETag, with no body", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `av-304-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Cached",
    });
    await users.setAvatar(target.id, AVATAR_DATA_URL);
    const headers = { cookie: `session=${admin.token}` };

    const first = await app.request(`/api/admin/users/${target.id}/avatar`, { headers });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const revalidated = await app.request(`/api/admin/users/${target.id}/avatar`, {
      headers: { ...headers, "if-none-match": etag! },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(await revalidated.text()).toBe("");
  });

  it("honors a weak validator and '*' in If-None-Match", async () => {
    const admin = await createAdmin();
    const target = await users.create({
      email: `av-weak-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Weak",
    });
    await users.setAvatar(target.id, AVATAR_DATA_URL);
    const headers = { cookie: `session=${admin.token}` };
    const url = `/api/admin/users/${target.id}/avatar`;

    const first = await app.request(url, { headers });
    const etag = first.headers.get("etag")!;

    const weak = await app.request(url, {
      headers: { ...headers, "if-none-match": `W/${etag}` },
    });
    expect(weak.status).toBe(304);

    const star = await app.request(url, {
      headers: { ...headers, "if-none-match": "*" },
    });
    expect(star.status).toBe(304);
  });
});
