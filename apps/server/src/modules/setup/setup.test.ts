import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSsoConfigRepo } from "../../infra/repos/sso-config";
import { createAuditRepo } from "../../infra/repos/audit";
import { importMasterKey } from "../credentials/crypto";
import { createApp } from "../../app";
import { createBootstrap } from "./bootstrap";
import { createSetupRouter } from "./router";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
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
