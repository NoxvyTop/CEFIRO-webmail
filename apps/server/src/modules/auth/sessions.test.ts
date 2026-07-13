import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createApp } from "../../app";
import { createAuthRouter } from "./router";
import { createSessionStore } from "./sessions";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const sessions = createSessionStore(sql);
const app = createApp({ authRouter: createAuthRouter({ sessions }) });

let userId: string;
let email: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  email = `s-${crypto.randomUUID()}@noxvytop.com`;
  userId = (await createUsersRepo(sql).create({ email, displayName: "S User" })).id;
});
afterAll(() => sql.end());

describe("sessions", () => {
  it("rejects /me without a cookie", async () => {
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
  });

  it("accepts /me with a valid session and hashes the token at rest", async () => {
    const { token } = await sessions.create(userId, 1);
    const res = await app.request("/api/auth/me", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe(email);

    const raw = await sql`select 1 from sessions where id = ${token}`;
    expect(raw.length).toBe(0); // raw token must never be stored
  });

  it("rejects an expired session", async () => {
    const { token } = await sessions.create(userId, -1);
    const res = await app.request("/api/auth/me", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("logout revokes the session", async () => {
    const { token } = await sessions.create(userId, 1);
    const out = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `session=${token}` },
    });
    expect(out.status).toBe(200);
    const res = await app.request("/api/auth/me", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(401);
  });
});
