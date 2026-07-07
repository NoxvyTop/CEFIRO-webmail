import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createFilterRulesRepo } from "../../infra/repos/filter-rules";
import { createVacationSettingsRepo } from "../../infra/repos/vacation-settings";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createSieveRouter } from "./router";
import { DomainError } from "../../core/errors";
import type { JmapClient, JmapMethodCall, JmapSession } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let filterRules: ReturnType<typeof createFilterRulesRepo>;
let vacationSettings: ReturnType<typeof createVacationSettingsRepo>;
let token: string;
let token2: string;
let token3: string;
let userId: string;
let user3Id: string;

const ruleBody = {
  name: "invoices",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "billing@" }],
  actions: [{ type: "fileinto", folder: "Invoices" }],
  enabled: true,
};

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  filterRules = createFilterRulesRepo(sql);
  vacationSettings = createVacationSettingsRepo(sql);
  sessions = createSessionStore(sql);

  const user1 = await users.create({
    email: `sieve-r1-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve Router User 1",
  });
  userId = user1.id;
  token = (await sessions.create(user1.id, 1)).token;

  const user2 = await users.create({
    email: `sieve-r2-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve Router User 2",
  });
  token2 = (await sessions.create(user2.id, 1)).token;

  const user3 = await users.create({
    email: `sieve-r3-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve Router User 3",
  });
  user3Id = user3.id;
  token3 = (await sessions.create(user3.id, 1)).token;

  await sql`
    insert into mail_credentials (user_id, ciphertext, iv, key_version)
    values (${user3Id}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(12))}, 1)
  `;
});
afterAll(() => sql.end());

function makeApp(jmap: JmapClient | null) {
  return createApp({
    sieveRouter: createSieveRouter({
      sessions,
      mailCredentials,
      filterRules,
      vacationSettings,
      jmap,
    }),
  });
}

function stubJmap(): { client: JmapClient; uploads: string[] } {
  const uploads: string[] = [];
  const session: JmapSession = {
    apiUrl: "http://stalwart/jmap/api",
    accountId: "acc1",
    eventSourceUrl: "",
    uploadUrl: "http://stalwart/upload/{accountId}/",
    downloadUrl: "",
  };
  const client = {
    async getSession() {
      return session;
    },
    async request(_auth: unknown, _session: unknown, calls: JmapMethodCall[]) {
      const [method] = calls[0]!;
      if (method === "Mailbox/get") {
        return [["Mailbox/get", { list: [{ name: "Papelera", role: "trash" }] }, "0"]];
      }
      if (method === "SieveScript/get") {
        return [["SieveScript/get", { list: [] }, "0"]];
      }
      if (method === "SieveScript/validate") {
        return [["SieveScript/validate", { error: null }, "0"]];
      }
      return [[method, {}, "0"]];
    },
    async uploadBlob(_auth: unknown, _session: unknown, content: string) {
      uploads.push(content);
      return "blob1";
    },
  } as unknown as JmapClient;
  return { client, uploads };
}

function brokenJmap(): JmapClient {
  return {
    async getSession() {
      throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
    },
    async request() {
      throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
    },
    async uploadBlob() {
      throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
    },
  } as unknown as JmapClient;
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown, cookie = token) {
  return app.request(path, {
    method: "POST",
    headers: { cookie: `session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(app: ReturnType<typeof makeApp>, path: string, body: unknown, cookie = token) {
  return app.request(path, {
    method: "PUT",
    headers: { cookie: `session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sieve routes", () => {
  it("requires a session", async () => {
    const res = await makeApp(null).request("/api/mail/filters");
    expect(res.status).toBe(401);
  });

  it("rejects invalid rule bodies", async () => {
    const res = await post(makeApp(null), "/api/mail/filters", { name: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("does full CRUD without JMAP configured (sync skipped)", async () => {
    const app = makeApp(null);
    const createRes = await post(app, "/api/mail/filters", ruleBody);
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.name).toBe("invoices");

    const listRes = await app.request("/api/mail/filters", {
      headers: { cookie: `session=${token}` },
    });
    const list = (await listRes.json()) as { id: string }[];
    expect(list.some((r) => r.id === created.id)).toBe(true);

    const updateRes = await put(app, `/api/mail/filters/${created.id}`, {
      ...ruleBody,
      name: "renamed",
    });
    expect(updateRes.status).toBe(200);

    const foreignRes = await put(
      app,
      `/api/mail/filters/${created.id}`,
      { ...ruleBody, name: "hijack" },
      token2,
    );
    expect(foreignRes.status).toBe(404);

    const orderRes = await put(app, "/api/mail/filters/order", { ids: [created.id] });
    expect(orderRes.status).toBe(200);

    const badOrderRes = await put(app, "/api/mail/filters/order", {
      ids: [crypto.randomUUID()],
    });
    expect(badOrderRes.status).toBe(400);
    expect(((await badOrderRes.json()) as { code: string }).code).toBe("invalid_order");

    const deleteRes = await app.request(`/api/mail/filters/${created.id}`, {
      method: "DELETE",
      headers: { cookie: `session=${token}` },
    });
    expect(deleteRes.status).toBe(200);
  });

  it("syncs the generated script when JMAP works", async () => {
    await mailCredentials.set(userId, "mailbox-pw");
    const { client, uploads } = stubJmap();
    const res = await post(makeApp(client), "/api/mail/filters", {
      ...ruleBody,
      name: "synced rule",
      actions: [{ type: "delete" }],
    });
    expect(res.status).toBe(200);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain("# rule: synced rule");
    expect(uploads[0]).toContain('fileinto "Papelera";');
  });

  it("returns sieve_sync_failed but keeps the rule when Stalwart is down", async () => {
    const app = makeApp(brokenJmap());
    const res = await post(app, "/api/mail/filters", { ...ruleBody, name: "pending rule" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("sieve_sync_failed");

    const listRes = await makeApp(null).request("/api/mail/filters", {
      headers: { cookie: `session=${token}` },
    });
    const list = (await listRes.json()) as { name: string }[];
    expect(list.some((r) => r.name === "pending rule")).toBe(true);
  });

  it("reapplies filters on demand", async () => {
    const { client, uploads } = stubJmap();
    const res = await post(makeApp(client), "/api/mail/filters/sync", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
    expect(uploads).toHaveLength(1);
  });

  it("reports skipped when the user has no mailbox credential", async () => {
    const { client } = stubJmap();
    const res = await post(makeApp(client), "/api/mail/filters/sync", {}, token2);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("skipped");
  });

  it("reports failed, not skipped, when the credential row cannot be decrypted", async () => {
    const { client } = stubJmap();
    const res = await post(makeApp(client), "/api/mail/filters/sync", {}, token3);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("sieve_sync_failed");
  });

  it("reads default vacation settings and round-trips an update", async () => {
    const app = makeApp(null);
    const getRes = await app.request("/api/mail/vacation", {
      headers: { cookie: `session=${token2}` },
    });
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { enabled: boolean }).enabled).toBe(false);

    const putRes = await put(
      app,
      "/api/mail/vacation",
      {
        enabled: true,
        subject: "Out",
        message: "Away until the 20th",
        startsAt: "2026-07-10",
        endsAt: "2026-07-20",
        intervalDays: 3,
      },
      token2,
    );
    expect(putRes.status).toBe(200);
    expect(((await putRes.json()) as { startsAt: string }).startsAt).toBe("2026-07-10");
  });

  it("rejects enabled vacation with a blank message", async () => {
    const res = await put(makeApp(null), "/api/mail/vacation", {
      enabled: true,
      message: "   ",
    });
    expect(res.status).toBe(400);
  });
});
