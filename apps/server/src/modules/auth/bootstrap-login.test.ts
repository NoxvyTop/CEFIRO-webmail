import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createAuditRepo } from "../../infra/repos/audit";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createAuthRouter } from "./router";
import { createSessionStore } from "./sessions";
import { createBootstrap, type Bootstrap } from "../setup/bootstrap";

const sql = createDb(testDatabaseUrl());

// Operator-set break-glass credential (GH #235): the process no longer mints
// one, so a bootstrap that is meant to be enabled has to be handed a secret.
const BOOTSTRAP_PASSWORD = "test-bootstrap-secret-0123456789";

function cookieValue(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    if (line.startsWith(`${name}=`)) return line.split(";")[0]!.slice(name.length + 1);
  }
  return null;
}

function makeApp(boot: Bootstrap) {
  return createApp({
    authRouter: createAuthRouter({
      sessions: createSessionStore(sql),
      users: createUsersRepo(sql),
      audit: createAuditRepo(sql),
      bootstrap: boot,
      appUrl: "http://localhost:5173",
      sessionTtlHours: 1,
    }),
  });
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("bootstrap login", () => {
  it("logs in the bootstrap admin and issues an admin session", async () => {
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const app = makeApp(boot);
    const res = await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bootstrap-admin", password: boot.password }),
    });
    expect(res.status).toBe(200);
    const session = cookieValue(res, "session");
    expect(session).toBeTruthy();
    const me = await app.request("/api/auth/me", { headers: { cookie: `session=${session}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { role: string }).role).toBe("admin");
  });

  it("rejects a wrong credential", async () => {
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const res = await makeApp(boot).request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(cookieValue(res, "session")).toBeNull();
  });

  it("is 404 when bootstrap is disabled", async () => {
    const res = await makeApp(createBootstrap(false)).request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: "y" }),
    });
    expect(res.status).toBe(404);
  });

  // GH #235: the credential is the operator's to set now, and a bootstrap flag
  // with nothing behind it must fail SAFE — no door rather than a door with an
  // unknown key. core/config.ts refuses to boot in this state; this pins what
  // the module itself does if it is ever reached anyway.
  it("stays shut when bootstrap mode is on but no credential was configured", async () => {
    const res = await makeApp(createBootstrap(true, undefined)).request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: "" }),
    });
    expect(res.status).toBe(404);
  });

  it("400 on invalid body", async () => {
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const res = await makeApp(boot).request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });

  it("reuses the reserved admin row on repeat login", async () => {
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const app = makeApp(boot);
    await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: boot.password }),
    });
    await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: boot.password }),
    });
    const rows = (await createUsersRepo(sql).list()).filter(
      (u) => u.email === "bootstrap-admin@webmail.local",
    );
    expect(rows.length).toBe(1);
  });
});
