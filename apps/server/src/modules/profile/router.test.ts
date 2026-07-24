import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo, type UserRecord } from "../../infra/repos/users";
import { createAuditRepo } from "../../infra/repos/audit";
import { createApp } from "../../app";
import { createSessionStore } from "../auth/sessions";
import { createAuthRouter } from "../auth/router";
import { createProfileRouter } from "./router";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const sessions = createSessionStore(sql);
const users = createUsersRepo(sql);
const audit = createAuditRepo(sql);
let app: ReturnType<typeof createApp>;

const SMALL_PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

async function createSessionUser(displayName = "Profile User"): Promise<{ user: UserRecord; token: string }> {
  const u = await users.create({
    email: `profile-${crypto.randomUUID()}@noxvytop.com`,
    displayName,
  });
  const { token } = await sessions.create(u.id, 1);
  return { user: u, token };
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  app = createApp({
    authRouter: createAuthRouter({ sessions }),
    profileRouter: createProfileRouter({ sessions, users, audit }),
  });
});
afterAll(() => sql.end());

describe("profile api", () => {
  it("GET /api/profile: 401 without a session", async () => {
    const res = await app.request("/api/profile");
    expect(res.status).toBe(401);
  });

  it("GET /api/profile: returns displayName, email, avatarDataUrl for the session user", async () => {
    const { user, token } = await createSessionUser("Ana");
    const res = await app.request("/api/profile", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; email: string; avatarDataUrl: string | null };
    expect(body).toEqual({ displayName: "Ana", email: user.email, avatarDataUrl: null });
  });

  it("PATCH /api/profile: updates displayName only, leaving a previously-set avatar untouched", async () => {
    const { user, token } = await createSessionUser("Original");
    const setAvatar = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar: SMALL_PNG_DATA_URL }),
    });
    expect(setAvatar.status).toBe(200);

    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; email: string; avatarDataUrl: string | null };
    expect(body).toEqual({ displayName: "Renamed", email: user.email, avatarDataUrl: SMALL_PNG_DATA_URL });
  });

  it("PATCH /api/profile: updates avatar only, leaving displayName untouched, and records a profile.update audit entry", async () => {
    const { user, token } = await createSessionUser("Stays Same");
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar: SMALL_PNG_DATA_URL }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; email: string; avatarDataUrl: string | null };
    expect(body).toEqual({ displayName: "Stays Same", email: user.email, avatarDataUrl: SMALL_PNG_DATA_URL });

    const auditRows = await sql<{ action: string; actor: string }[]>`
      select action, actor from audit_log
      where action = 'profile.update' and actor = ${user.email}
      order by created_at desc limit 1
    `;
    expect(auditRows[0]?.actor).toBe(user.email);
  });

  it("PATCH /api/profile: rejects an oversized avatar with 400", async () => {
    const { token } = await createSessionUser();
    const oversized = `data:image/png;base64,${"A".repeat(1_500_000)}`;
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar: oversized }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/profile: rejects an svg avatar with 400", async () => {
    const { token } = await createSessionUser();
    const svgDataUrl = "data:image/svg+xml;base64,aGVsbG8=";
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar: svgDataUrl }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/profile: rejects an empty/whitespace-only displayName with 400", async () => {
    const { token } = await createSessionUser();
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/profile: 401 without a session", async () => {
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Nope" }),
    });
    expect(res.status).toBe(401);
  });

  it("PATCH /api/profile: always targets the session user — an id in the body is ignored", async () => {
    const { token: tokenA } = await createSessionUser("User A");
    const { user: userB } = await createSessionUser("User B");

    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ id: userB.id, displayName: "Hijacked" }),
    });
    expect(res.status).toBe(200);

    const getA = await app.request("/api/profile", { headers: { cookie: `session=${tokenA}` } });
    const bodyA = (await getA.json()) as { displayName: string };
    expect(bodyA.displayName).toBe("Hijacked");

    const profileB = await users.getProfile(userB.id);
    expect(profileB?.displayName).toBe("User B");
  });

  it("GET /api/auth/me does not include avatarDataUrl, even after an avatar has been set", async () => {
    const { token } = await createSessionUser("Me Lean");
    await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar: SMALL_PNG_DATA_URL }),
    });

    const me = await app.request("/api/auth/me", {
      headers: { cookie: `session=${token}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("avatarDataUrl");
  });

  it("PATCH /api/profile: rejects an oversized raw request body with 413 before it is parsed", async () => {
    const { token } = await createSessionUser();
    // Larger than the 2MB bodyLimit cap. Deliberately not valid JSON: the
    // point is that this must be rejected by size alone, before any
    // JSON.parse or zod validation runs.
    const oversizedRawBody = "x".repeat(3 * 1024 * 1024);
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: oversizedRawBody,
    });
    expect(res.status).toBe(413);
  });

  it("PATCH /api/profile: a no-op {} body returns the current profile unchanged and records no audit entry", async () => {
    const { user, token } = await createSessionUser("No Op User");

    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; email: string; avatarDataUrl: string | null };
    expect(body).toEqual({ displayName: "No Op User", email: user.email, avatarDataUrl: null });

    const auditRows = await sql<{ action: string }[]>`
      select action from audit_log
      where action = 'profile.update' and actor = ${user.email}
    `;
    expect(auditRows).toHaveLength(0);
  });

  it("PATCH /api/profile: rejects a structurally malformed avatar value with 400", async () => {
    const { token } = await createSessionUser();
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar: "not-a-data-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/profile: rejects an avatar data URL with non-base64 payload characters with 400", async () => {
    const { token } = await createSessionUser();
    const res = await app.request("/api/profile", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar: "data:image/png;base64,not-valid-base64!!" }),
    });
    expect(res.status).toBe(400);
  });
});
