import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { ActiveSession } from "@webmail/shared";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createApp } from "../../app";
import { createAuthRouter } from "./router";
import { createSessionStore } from "./sessions";

// #302: a user can list their active sessions/devices and revoke them
// individually or "all the others", scoped strictly to their own sessions. The
// token stays hashed at rest and is never exposed.
const sql = createDb(testDatabaseUrl());
const sessions = createSessionStore(sql);
const app = createApp({ authRouter: createAuthRouter({ sessions }) });

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

async function freshUser(): Promise<string> {
  const user = await createUsersRepo(sql).create({
    email: `sess-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sess User",
  });
  return user.id;
}

async function listOver(token: string): Promise<ActiveSession[]> {
  const res = await app.request("/api/auth/sessions", { headers: { cookie: `session=${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as ActiveSession[];
}

describe("session store: list / revoke (#302)", () => {
  it("lists a user's active sessions, flags the current one, and never returns the token", async () => {
    const userId = await freshUser();
    const a = await sessions.create(userId, 12, { userAgent: "Firefox/1.0", ip: "203.0.113.5" });
    await sessions.create(userId, 12, { userAgent: "Safari/2.0", ip: "203.0.113.9" });

    const list = await sessions.list(userId, a.token);
    expect(list).toHaveLength(2);
    const current = list.filter((s) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.userAgent).toBe("Firefox/1.0");
    expect(current[0]!.ip).toBe("203.0.113.5");
    // The id is the SHA-256 hash handle, never the raw token.
    for (const s of list) {
      expect(s.id).not.toBe(a.token);
      expect(s.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("excludes expired sessions from the list", async () => {
    const userId = await freshUser();
    const live = await sessions.create(userId, 12);
    await sessions.create(userId, -1); // already past its absolute expiry
    const list = await sessions.list(userId, live.token);
    expect(list).toHaveLength(1);
    expect(list[0]!.current).toBe(true);
  });

  it("revokeById is scoped to the owner and reports whether a row was removed", async () => {
    const owner = await freshUser();
    const other = await freshUser();
    const mine = await sessions.create(owner, 12);
    const theirs = await sessions.create(other, 12);
    const [row] = await sessions.list(owner, mine.token);

    // Another user cannot revoke the owner's session.
    expect(await sessions.revokeById(other, row!.id)).toBe(false);
    expect(await sessions.findUser(mine.token)).not.toBeNull();

    // The owner can.
    expect(await sessions.revokeById(owner, row!.id)).toBe(true);
    expect(await sessions.findUser(mine.token)).toBeNull();

    // The other user's session was never touched.
    expect(await sessions.findUser(theirs.token)).not.toBeNull();
  });

  it("revokeOthers removes every session but the current one", async () => {
    const userId = await freshUser();
    const current = await sessions.create(userId, 12);
    const b = await sessions.create(userId, 12);
    const c = await sessions.create(userId, 12);

    const revoked = await sessions.revokeOthers(userId, current.token);
    expect(revoked).toBe(2);
    expect(await sessions.findUser(current.token)).not.toBeNull();
    expect(await sessions.findUser(b.token)).toBeNull();
    expect(await sessions.findUser(c.token)).toBeNull();
  });
});

describe("session management endpoints (#302)", () => {
  it("requires a session", async () => {
    expect((await app.request("/api/auth/sessions")).status).toBe(401);
    expect(
      (await app.request("/api/auth/sessions/whatever", { method: "DELETE" })).status,
    ).toBe(401);
    expect(
      (await app.request("/api/auth/sessions/revoke-others", { method: "POST" })).status,
    ).toBe(401);
  });

  it("GET /sessions lists the caller's own sessions and flags the current one", async () => {
    const userId = await freshUser();
    const current = await sessions.create(userId, 12, { userAgent: "Edge/9", ip: "198.51.100.7" });
    await sessions.create(userId, 12);

    const list = await listOver(current.token);
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.current)?.ip).toBe("198.51.100.7");
  });

  it("DELETE /sessions/:id revokes one, 404s an unknown or another user's id", async () => {
    const owner = await freshUser();
    const other = await freshUser();
    const keep = await sessions.create(owner, 12);
    const drop = await sessions.create(owner, 12);
    const ownerList = await sessions.list(owner, keep.token);
    const dropId = ownerList.find((s) => !s.current)!.id;

    // Unknown id → 404.
    const unknown = await app.request("/api/auth/sessions/deadbeef", {
      method: "DELETE",
      headers: { cookie: `session=${keep.token}` },
    });
    expect(unknown.status).toBe(404);

    // Another user's cookie cannot delete the owner's session (scoped → 404).
    const crossUser = await app.request(`/api/auth/sessions/${dropId}`, {
      method: "DELETE",
      headers: { cookie: `session=${(await sessions.create(other, 12)).token}` },
    });
    expect(crossUser.status).toBe(404);
    expect(await sessions.findUser(drop.token)).not.toBeNull();

    // The owner can, and the current session survives.
    const ok = await app.request(`/api/auth/sessions/${dropId}`, {
      method: "DELETE",
      headers: { cookie: `session=${keep.token}` },
    });
    expect(ok.status).toBe(200);
    expect(await sessions.findUser(drop.token)).toBeNull();
    expect(await sessions.findUser(keep.token)).not.toBeNull();
  });

  it("DELETE of the current session clears its cookie", async () => {
    const userId = await freshUser();
    const current = await sessions.create(userId, 12);
    const [row] = await sessions.list(userId, current.token);

    const res = await app.request(`/api/auth/sessions/${row!.id}`, {
      method: "DELETE",
      headers: { cookie: `session=${current.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("session=");
    expect(await sessions.findUser(current.token)).toBeNull();
  });

  it("POST /sessions/revoke-others keeps the current session and reports the count", async () => {
    const userId = await freshUser();
    const current = await sessions.create(userId, 12);
    await sessions.create(userId, 12);
    await sessions.create(userId, 12);

    const res = await app.request("/api/auth/sessions/revoke-others", {
      method: "POST",
      headers: { cookie: `session=${current.token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: number }).revoked).toBe(2);
    expect(await sessions.findUser(current.token)).not.toBeNull();
    expect(await sessions.list(userId, current.token)).toHaveLength(1);
  });
});
