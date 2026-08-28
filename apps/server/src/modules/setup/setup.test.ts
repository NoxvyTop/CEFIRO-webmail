import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createRateLimiter } from "../../core/rate-limit";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo, type UsersRepo } from "../../infra/repos/users";
import {
  createMailCredentialsRepo,
  type MailCredentialsRepo,
} from "../../infra/repos/mail-credentials";
import { createSsoConfigRepo, type SsoConfigRepo } from "../../infra/repos/sso-config";
import { createAuditRepo, type AuditRepo } from "../../infra/repos/audit";
import { importMasterKey } from "../credentials/crypto";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createBootstrap } from "./bootstrap";
import type { SetupCompletion } from "./completion";
import { createSetupRouter } from "./router";

const sql = createDb(testDatabaseUrl());
let masterKey: CryptoKey;
let bootstrap: ReturnType<typeof createBootstrap>;
let app: ReturnType<typeof createApp>;

// Operator-set break-glass credential (GH #235): the process no longer mints
// one, so a bootstrap that is meant to be enabled has to be handed a secret.
// It doubles as the setup token, exactly as in a real deployment.
const BOOTSTRAP_PASSWORD = "test-bootstrap-secret-0123456789";

// GH #234. Every test below exercises a setup that has NOT finished, which the
// completion latch has to be told explicitly: the suite shares one database
// across every test file, so whether an active admin and an SSO row happen to
// exist by the time this file runs depends on file order, not on anything
// asserted here. The latch's own behaviour is covered in the describe at the
// bottom, against the real createSetupCompletion.
const MID_SETUP: SetupCompletion = { isComplete: async () => false };

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  bootstrap = createBootstrap(true, BOOTSTRAP_PASSWORD);
  app = createApp({
    setupRouter: createSetupRouter({
      bootstrap,
      users: createUsersRepo(sql),
      mailCredentials: createMailCredentialsRepo(sql, masterKey),
      ssoConfig: createSsoConfigRepo(sql, masterKey),
      audit: createAuditRepo(sql),
      completion: MID_SETUP,
    }),
  });
});
afterAll(() => sql.end());

describe("setup api", () => {
  it("is invisible when bootstrap mode is off", async () => {
    const off = createApp({
      // No `completion` here on purpose: a router built the way index.ts builds
      // it, deriving the latch from its own repositories.
      setupRouter: createSetupRouter({
        bootstrap: createBootstrap(false),
        users: createUsersRepo(sql),
        mailCredentials: createMailCredentialsRepo(sql, masterKey),
        ssoConfig: createSsoConfigRepo(sql, masterKey),
        audit: createAuditRepo(sql),
      }),
    });
    expect((await off.request("/api/setup/status")).status).toBe(404);
  });

  it("rejects a wrong token", async () => {
    const res = await app.request("/api/setup/status", {
      headers: { "x-setup-token": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("reports status with the correct token", async () => {
    const res = await app.request("/api/setup/status", {
      headers: { "x-setup-token": bootstrap.password! },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bootstrapMode: boolean; userCount: number };
    expect(body.bootstrapMode).toBe(true);
    expect(body.userCount).toBeGreaterThanOrEqual(0);
  });

  it("saves sso config and creates a user with credential", async () => {
    const sso = await app.request("/api/setup/sso", {
      method: "PUT",
      headers: { "x-setup-token": bootstrap.password!, "content-type": "application/json" },
      body: JSON.stringify({
        issuer: "https://auth.noxvytop.com",
        clientId: "webmail",
        clientSecret: "cs-1",
        scopes: "openid email",
      }),
    });
    expect(sso.status).toBe(200);

    const email = `setup-${crypto.randomUUID()}@noxvytop.com`;
    const user = await app.request("/api/setup/users", {
      method: "POST",
      headers: { "x-setup-token": bootstrap.password!, "content-type": "application/json" },
      body: JSON.stringify({
        email,
        displayName: "Setup User",
        mailPassword: "mailbox-pass-123",
      }),
    });
    expect(user.status).toBe(200);
    const body = (await user.json()) as Record<string, unknown>;
    expect(body.email).toBe(email);
    expect(JSON.stringify(body)).not.toContain("mailbox-pass-123");

    const stored = await createMailCredentialsRepo(sql, masterKey).get(body.id as string);
    expect(stored).toBe("mailbox-pass-123");

    const dup = await app.request("/api/setup/users", {
      method: "POST",
      headers: { "x-setup-token": bootstrap.password!, "content-type": "application/json" },
      body: JSON.stringify({ email, displayName: "Dup", mailPassword: "mailbox-pass-123" }),
    });
    expect(dup.status).toBe(409);
  });

  it("rejects an invalid body", async () => {
    const res = await app.request("/api/setup/users", {
      method: "POST",
      headers: { "x-setup-token": bootstrap.password!, "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", displayName: "", mailPassword: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

// GH #222. The setup API accepts the same 144-bit break-glass secret as the
// bootstrap login but had none of the hardening #183/#194 gave that path.
describe("setup api hardening", () => {
  /** A router with a limit small enough to exhaust in a test. */
  function limitedApp(limit: number) {
    return createApp({
      setupRouter: createSetupRouter({
        bootstrap,
        users: createUsersRepo(sql),
        mailCredentials: createMailCredentialsRepo(sql, masterKey),
        ssoConfig: createSsoConfigRepo(sql, masterKey),
        audit: createAuditRepo(sql),
        rateLimiter: createRateLimiter({ limit, windowMs: 60_000 }),
        completion: MID_SETUP,
      }),
    });
  }

  async function failedAuthCount(ip: string): Promise<number> {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where action = 'setup.auth_failed' and ip = ${ip}
    `;
    return rows[0]?.n ?? 0;
  }

  /**
   * A distinct address per test: audit_log is append-only and shared by the
   * whole suite, so an assertion has to count rows only its own test could have
   * written. Shaped like a real address rather than a suffixed UUID because
   * core/client-ip.ts refuses anything longer than the longest possible IPv6
   * (GH #238) — a rate-limit key and an audit row must not be arbitrary-length
   * attacker text.
   */
  function uniqueIp(): string {
    return `203.0.113.${1 + Math.floor(Math.random() * 250)}:${crypto.randomUUID().slice(0, 8)}`;
  }

  it("audits a rejected setup token with the client IP", async () => {
    const ip = uniqueIp();
    const res = await app.request("/api/setup/status", {
      headers: { "x-setup-token": "wrong", "x-forwarded-for": ip },
    });

    expect(res.status).toBe(401);
    expect(await failedAuthCount(ip)).toBe(1);
  });

  it("rate limits repeated attempts per IP and answers 429 with Retry-After", async () => {
    const limited = limitedApp(2);
    const ip = uniqueIp();
    const attempt = () =>
      limited.request("/api/setup/status", {
        headers: { "x-setup-token": "wrong", "x-forwarded-for": ip },
      });

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The point of the gate: a blocked attempt writes no audit row at all.
    expect(await failedAuthCount(ip)).toBe(2);
  });

  it("gates a valid token too, so a flood cannot ride on a leaked one", async () => {
    const limited = limitedApp(1);
    const ip = uniqueIp();
    const attempt = () =>
      limited.request("/api/setup/status", {
        headers: { "x-setup-token": bootstrap.password!, "x-forwarded-for": ip },
      });

    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(429);
  });

  // GH #238. This middleware used to key on the RAW header, so the whole
  // comma-separated string was the bucket: one junk hop per request bought an
  // unlimited number of fresh budgets against an unauthenticated router that
  // holds the same 144-bit secret as the break-glass login.
  it("cannot be escaped by prepending forged hops to X-Forwarded-For", async () => {
    const limited = limitedApp(2);
    const real = uniqueIp();
    const attempt = (forwardedFor: string) =>
      limited.request("/api/setup/status", {
        headers: { "x-setup-token": "wrong", "x-forwarded-for": forwardedFor },
      });

    expect((await attempt(real)).status).toBe(401);
    // Same client, a different forged prefix each time. The trusted hop is
    // still the rightmost entry, so all three land in one bucket.
    expect((await attempt(`1.2.3.4, ${real}`)).status).toBe(401);
    expect((await attempt(`5.6.7.8, 9.9.9.9, ${real}`)).status).toBe(429);
    // And nothing it forged became an audit row of its own.
    expect(await failedAuthCount(real)).toBe(2);
    expect(await failedAuthCount("1.2.3.4")).toBe(0);
  });

  it("sends a request with a shorter chain than declared to the shared bucket", async () => {
    // A caller that reaches this process without passing the trusted proxy
    // carries no attributable hop. It must land in ONE shared bucket rather
    // than in a bucket of its own choosing — the failure has to lean that way.
    const limited = limitedApp(1);
    expect(
      (await limited.request("/api/setup/status", { headers: { "x-setup-token": "wrong" } }))
        .status,
    ).toBe(401);
    expect(
      (await limited.request("/api/setup/status", {
        headers: { "x-setup-token": "wrong", "x-forwarded-for": "" },
      })).status,
    ).toBe(429);
  });

  it("answers 400, not 500, when PUT /sso carries a malformed JSON body", async () => {
    const res = await app.request("/api/setup/sso", {
      method: "PUT",
      headers: { "x-setup-token": bootstrap.password!, "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("answers 400, not 500, when POST /users carries a malformed JSON body", async () => {
    const res = await app.request("/api/setup/users", {
      method: "POST",
      headers: { "x-setup-token": bootstrap.password!, "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });
});

// GH #234. The env flag used to be the only gate, so a `BOOTSTRAP_MODE=true`
// left on in production kept an unauthenticated privilege-escalation path open
// forever. These build the router the way index.ts does — no injected
// completion — so the real createSetupCompletion runs against repositories
// whose state the test states outright, instead of whatever the shared database
// happens to hold when this file runs.
describe("setup completion latch (GH #234)", () => {
  function latchApp(state: { activeAdmins: number; ssoConfigured: boolean }) {
    const users = {
      countActiveAdmins: async () => state.activeAdmins,
      count: async () => state.activeAdmins,
    } as unknown as UsersRepo;
    const ssoConfig = {
      exists: async () => state.ssoConfigured,
    } as unknown as SsoConfigRepo;
    const audit = { record: vi.fn(async () => {}) };
    const app = createApp({
      setupRouter: createSetupRouter({
        bootstrap,
        users,
        mailCredentials: {} as unknown as MailCredentialsRepo,
        ssoConfig,
        audit: audit as unknown as AuditRepo,
      }),
    });
    return { app, audit, state };
  }

  /** A request carrying the real, valid setup token. */
  function withToken(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
    return app.request(path, {
      ...init,
      headers: { "x-setup-token": bootstrap.password!, "content-type": "application/json" },
    });
  }

  it("refuses a completed instance even though BOOTSTRAP_MODE is still on", async () => {
    // The whole point: `bootstrap.enabled` is true here, and the caller holds
    // the real token. It is the second gate that shuts the door — on the two
    // routes that hand out the instance (repoint the IdP, mint an admin) as
    // much as on the harmless one.
    const { app } = latchApp({ activeAdmins: 1, ssoConfigured: true });
    expect(bootstrap.enabled).toBe(true);

    expect((await withToken(app, "/api/setup/status")).status).toBe(404);

    const sso = await withToken(app, "/api/setup/sso", {
      method: "PUT",
      body: JSON.stringify({
        issuer: "https://attacker.test",
        clientId: "theirs",
        clientSecret: "theirs",
        scopes: "openid email",
      }),
    });
    expect(sso.status).toBe(404);

    const user = await withToken(app, "/api/setup/users", {
      method: "POST",
      body: JSON.stringify({
        email: "intruder@noxvytop.com",
        displayName: "Intruder",
        role: "admin",
        mailPassword: "mailbox-pass-123",
      }),
    });
    expect(user.status).toBe(404);
  });

  it("stays open while setup is unfinished: an admin but no SSO yet", async () => {
    const { app } = latchApp({ activeAdmins: 1, ssoConfigured: false });
    expect((await withToken(app, "/api/setup/status")).status).toBe(200);
  });

  it("stays open with SSO configured but no active admin to sign in as", async () => {
    // The instance an operator is recovering: SSO exists, every admin is
    // archived. Closing here would leave nobody able to reach the console.
    const { app } = latchApp({ activeAdmins: 0, ssoConfigured: true });
    expect((await withToken(app, "/api/setup/status")).status).toBe(200);
  });

  it("closes the moment the second condition lands, mid-session", async () => {
    const { app, state } = latchApp({ activeAdmins: 0, ssoConfigured: true });
    expect((await withToken(app, "/api/setup/status")).status).toBe(200);

    state.activeAdmins = 1;

    expect((await withToken(app, "/api/setup/status")).status).toBe(404);
  });

  it("is one-way: deleting the SSO row under a running server does not reopen it", async () => {
    const { app, state } = latchApp({ activeAdmins: 1, ssoConfigured: true });
    expect((await withToken(app, "/api/setup/status")).status).toBe(404);

    state.ssoConfigured = false;
    state.activeAdmins = 0;

    expect((await withToken(app, "/api/setup/status")).status).toBe(404);
  });

  it("refuses ahead of the token check, so a closed router writes no audit rows", async () => {
    const { app, audit } = latchApp({ activeAdmins: 1, ssoConfigured: true });
    const res = await app.request("/api/setup/status", {
      headers: { "x-setup-token": "wrong", "x-forwarded-for": "203.0.113.99" },
    });
    // Same answer as a router that was never enabled: no 401 to tell a probe
    // that a setup API exists here, and no `setup.auth_failed` row to flood.
    expect(res.status).toBe(404);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
