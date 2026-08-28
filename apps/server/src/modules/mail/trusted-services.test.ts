import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { trustedServicesSchema } from "@webmail/shared";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo, MAX_TRUSTED_SERVICES } from "../../infra/repos/user-preferences";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createMailRouter } from "./router";
import { TRUSTED_SERVICES_SEED } from "./trusted-services-seed";

const sql = createDb(testDatabaseUrl());

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let userPreferences: ReturnType<typeof createUserPreferencesRepo>;
let token: string;
let userId: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  userPreferences = createUserPreferencesRepo(sql);
  sessions = createSessionStore(sql);

  const user = await users.create({
    email: `trust-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Trust User",
  });
  userId = user.id;
  token = (await sessions.create(user.id, 1)).token;
});
afterAll(() => sql.end());

// The user list lives in user_preferences, which persists across tests in this
// file; clear it so each test starts from the empty user list.
beforeEach(async () => {
  await sql`delete from user_preferences where user_id = ${userId}`;
});

// These routes never touch JMAP (the list is app-side state, like
// /preferences), so `jmap: null` is enough — and proves they do not hide
// behind requireMail.
function makeApp() {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences,
      jmap: null,
    }),
  });
}

function request(path: string, method = "GET", withSession = true) {
  return makeApp().request(`/api/mail/trusted-services${path}`, {
    method,
    headers: withSession ? { cookie: `session=${token}` } : {},
  });
}

describe("GET /api/mail/trusted-services (GH #314)", () => {
  it("requires a session", async () => {
    const res = await request("", "GET", false);
    expect(res.status).toBe(401);
  });

  it("returns the curated seed and an empty user list by default", async () => {
    const res = await request("");
    expect(res.status).toBe(200);
    const body = trustedServicesSchema.parse(await res.json());
    expect(body.seed).toEqual([...TRUSTED_SERVICES_SEED].sort());
    expect(body.user).toEqual([]);
  });
});

describe("PUT /api/mail/trusted-services/:domain (GH #314)", () => {
  it("adds a normalized domain to the user list and returns both lists", async () => {
    const res = await request("/Partner.Test", "PUT");
    expect(res.status).toBe(200);
    const body = trustedServicesSchema.parse(await res.json());
    expect(body.user).toEqual(["partner.test"]);
    expect(body.seed).toContain("github.com");

    expect((await userPreferences.get(userId)).trustedServices).toEqual(["partner.test"]);
  });

  it("is idempotent: trusting the same domain twice stores it once", async () => {
    await request("/partner.test", "PUT");
    const res = await request("/partner.test", "PUT");
    expect(res.status).toBe(200);
    expect(trustedServicesSchema.parse(await res.json()).user).toEqual(["partner.test"]);
  });

  it("keeps previously trusted domains (read-modify-write, not a shallow jsonb overwrite)", async () => {
    await request("/partner.test", "PUT");
    await request("/billing.example", "PUT");
    const res = await request("");
    expect(trustedServicesSchema.parse(await res.json()).user).toEqual([
      "partner.test",
      "billing.example",
    ]);
  });

  it("does not clobber unrelated preference keys", async () => {
    await userPreferences.merge(userId, { groupMailInMainInbox: false });
    await request("/partner.test", "PUT");
    const prefs = await userPreferences.get(userId);
    expect(prefs.groupMailInMainInbox).toBe(false);
    expect(prefs.trustedServices).toEqual(["partner.test"]);
  });

  it("rejects a value that is not a plain domain with 400 invalid_domain", async () => {
    for (const bad of ["user%40evil.test", "com", "%2A.evil.test", ".evil.test", "evil%20test.com"]) {
      const res = await request(`/${bad}`, "PUT");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_domain");
    }
    expect((await userPreferences.get(userId)).trustedServices).toEqual([]);
  });

  it("refuses to duplicate a seed entry into the user list (already trusted)", async () => {
    const res = await request("/github.com", "PUT");
    expect(res.status).toBe(200);
    const body = trustedServicesSchema.parse(await res.json());
    expect(body.user).toEqual([]);
    expect(body.seed).toContain("github.com");
  });

  // GH #314 (JD-3): the repo's parse drops everything past MAX_TRUSTED_SERVICES,
  // so a PUT at the cap wrote a list that read back one entry shorter — the
  // route still answered 200 and the reader's "Trust this service" affordance
  // toasted success while nothing had been stored. A limit the user cannot see
  // is worse than no limit: the badge simply never appears and there is nothing
  // to explain it.
  it("answers 409 trusted_services_limit at the cap instead of silently storing nothing", async () => {
    const full = Array.from({ length: MAX_TRUSTED_SERVICES }, (_, i) => `svc-${i}.example`);
    await userPreferences.merge(userId, { trustedServices: full });

    const res = await request("/one-too-many.example", "PUT");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("trusted_services_limit");
    expect((await userPreferences.get(userId)).trustedServices).toEqual(full);
  });

  it("stays idempotent at the cap: re-trusting a domain already on the full list still answers 200", async () => {
    const full = Array.from({ length: MAX_TRUSTED_SERVICES }, (_, i) => `svc-${i}.example`);
    await userPreferences.merge(userId, { trustedServices: full });

    const res = await request("/svc-0.example", "PUT");
    expect(res.status).toBe(200);
    expect(trustedServicesSchema.parse(await res.json()).user).toEqual(full);
  });

  it("accepts the last free slot — the cap refuses the one AFTER it, not the one at it", async () => {
    const nearlyFull = Array.from({ length: MAX_TRUSTED_SERVICES - 1 }, (_, i) => `svc-${i}.example`);
    await userPreferences.merge(userId, { trustedServices: nearlyFull });

    const res = await request("/last-slot.example", "PUT");
    expect(res.status).toBe(200);
    const stored = (await userPreferences.get(userId)).trustedServices;
    expect(stored).toHaveLength(MAX_TRUSTED_SERVICES);
    expect(stored).toContain("last-slot.example");
  });

  it("requires a session", async () => {
    const res = await request("/partner.test", "PUT", false);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/mail/trusted-services/:domain (GH #314)", () => {
  it("removes a domain from the user list and returns both lists", async () => {
    await request("/partner.test", "PUT");
    await request("/billing.example", "PUT");
    const res = await request("/PARTNER.test", "DELETE");
    expect(res.status).toBe(200);
    expect(trustedServicesSchema.parse(await res.json()).user).toEqual(["billing.example"]);
  });

  it("is a no-op for a domain that was never trusted", async () => {
    const res = await request("/never.example", "DELETE");
    expect(res.status).toBe(200);
    expect(trustedServicesSchema.parse(await res.json()).user).toEqual([]);
  });

  it("answers 409 trusted_service_seed for a seed entry — the seed cannot be edited per user", async () => {
    const res = await request("/github.com", "DELETE");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("trusted_service_seed");
  });

  it("rejects a malformed domain with 400 invalid_domain", async () => {
    const res = await request("/user%40evil.test", "DELETE");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_domain");
  });
});
