import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createSessionStore } from "../auth/sessions";
import type { AuthVariables } from "../auth/middleware";
import { requireAdmin } from "./middleware";

const sql = createDb(testDatabaseUrl());
const sessions = createSessionStore(sql);

function appWithGuard() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("traceId", "t");
    await next();
  });
  app.get("/admin/ping", ...requireAdmin(sessions), (c) => c.json({ ok: true }));
  return app;
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("requireAdmin", () => {
  it("401 without a session", async () => {
    const res = await appWithGuard().request("/admin/ping");
    expect(res.status).toBe(401);
  });
  it("403 for an employee session", async () => {
    const u = await createUsersRepo(sql).create({
      email: `e-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "E",
    });
    const { token } = await sessions.create(u.id, 1);
    const res = await appWithGuard().request("/admin/ping", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(403);
  });
  it("200 for an admin session", async () => {
    const u = await createUsersRepo(sql).create({
      email: `ad-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Ad",
      role: "admin",
    });
    const { token } = await sessions.create(u.id, 1);
    const res = await appWithGuard().request("/admin/ping", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
  });
});
