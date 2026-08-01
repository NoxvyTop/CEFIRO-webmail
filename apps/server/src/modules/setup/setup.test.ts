import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createRateLimiter } from "../../core/rate-limit";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSsoConfigRepo } from "../../infra/repos/sso-config";
import { createAuditRepo } from "../../infra/repos/audit";
import { importMasterKey } from "../credentials/crypto";
import { createApp } from "../../app";
import { createBootstrap } from "./bootstrap";
import { createSetupRouter } from "./router";

const sql = createDb(testDatabaseUrl());
let masterKey: CryptoKey;
let bootstrap: ReturnType<typeof createBootstrap>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  bootstrap = createBootstrap(true);
  app = createApp({
    setupRouter: createSetupRouter({
      bootstrap,
      users: createUsersRepo(sql),
      mailCredentials: createMailCredentialsRepo(sql, masterKey),
      ssoConfig: createSsoConfigRepo(sql, masterKey),
      audit: createAuditRepo(sql),
    }),
  });
});
afterAll(() => sql.end());

describe("setup api", () => {
  it("is invisible when bootstrap mode is off", async () => {
    const off = createApp({
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

  it("audits a rejected setup token with the client IP", async () => {
    // Unique per run: audit_log is append-only and shared by the whole suite,
    // so the assertion has to count rows this test alone could have written.
    const ip = `203.0.113.7-${crypto.randomUUID()}`;
    const res = await app.request("/api/setup/status", {
      headers: { "x-setup-token": "wrong", "x-forwarded-for": ip },
    });

    expect(res.status).toBe(401);
    expect(await failedAuthCount(ip)).toBe(1);
  });

  it("rate limits repeated attempts per IP and answers 429 with Retry-After", async () => {
    const limited = limitedApp(2);
    const ip = `198.51.100.7-${crypto.randomUUID()}`;
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
    const ip = `198.51.100.9-${crypto.randomUUID()}`;
    const attempt = () =>
      limited.request("/api/setup/status", {
        headers: { "x-setup-token": bootstrap.password!, "x-forwarded-for": ip },
      });

    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(429);
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
