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
import type { SetupCompletion } from "../setup/completion";

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

function makeApp(boot: Bootstrap, completion?: SetupCompletion) {
  return createApp({
    authRouter: createAuthRouter({
      sessions: createSessionStore(sql),
      users: createUsersRepo(sql),
      audit: createAuditRepo(sql),
      bootstrap: boot,
      appUrl: "http://localhost:5173",
      sessionTtlHours: 1,
      ...(completion ? { completion } : {}),
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

  // GH #346: the same second gate the setup router got in #234. A
  // `BOOTSTRAP_MODE=true` left on after the instance is set up was a standing
  // offer of admin behind one static password, and the flag was the ONLY thing
  // guarding it.
  it("is 404 once the setup completion latch has closed", async () => {
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const app = makeApp(boot, { isComplete: async () => true });
    const res = await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: boot.password }),
    });
    // `not_found`, the same answer as a router that was never enabled: a
    // completed instance must not confirm that the break-glass door exists.
    expect(res.status).toBe(404);
    expect(cookieValue(res, "session")).toBeNull();
  });

  it("still opens while the latch is open", async () => {
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const app = makeApp(boot, { isComplete: async () => false });
    const res = await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: boot.password }),
    });
    expect(res.status).toBe(200);
  });

  // GH #346: an admin who archives the emergency account from the console was
  // being overruled — the next bootstrap login flipped `active` back on and
  // re-promoted the row. The break-glass path no longer writes to it at all.
  it("refuses an archived bootstrap admin instead of reactivating it", async () => {
    const users = createUsersRepo(sql);
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const app = makeApp(boot);
    await app.request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x", password: boot.password }),
    });
    const admin = await users.findByEmail("bootstrap-admin@webmail.local");
    expect(admin).toBeTruthy();
    await users.setActive(admin!.id, false);
    try {
      const res = await app.request("/api/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x", password: boot.password }),
      });
      // 401, not a 403 that would say "the account exists but is archived".
      expect(res.status).toBe(401);
      expect(cookieValue(res, "session")).toBeNull();
      expect((await users.findByEmail("bootstrap-admin@webmail.local"))?.active).toBe(false);
    } finally {
      // Leave the shared row as the other cases in this file expect to find it.
      await users.setActive(admin!.id, true);
    }
  });

  it("does not re-promote a demoted bootstrap admin", async () => {
    const users = createUsersRepo(sql);
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const app = makeApp(boot);
    const admin = await users.findByEmail("bootstrap-admin@webmail.local");
    expect(admin).toBeTruthy();
    await users.setRole(admin!.id, "employee");
    try {
      const res = await app.request("/api/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x", password: boot.password }),
      });
      // The session is still issued — the credential was right — but with the
      // role the console left on the row, not the one this path used to force
      // back on with `setRole`.
      expect(res.status).toBe(200);
      expect((await users.findByEmail("bootstrap-admin@webmail.local"))?.role).toBe("employee");
    } finally {
      await users.setRole(admin!.id, "admin");
    }
  });
});
