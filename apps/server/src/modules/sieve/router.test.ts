import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { sieveSyncStateSchema } from "@webmail/shared";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createFilterRulesRepo } from "../../infra/repos/filter-rules";
import { createVacationSettingsRepo } from "../../infra/repos/vacation-settings";
import { createSieveSyncStateRepo } from "../../infra/repos/sieve-sync-state";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createSieveRouter } from "./router";
import { DomainError } from "../../core/errors";
import type { JmapClient, JmapMethodCall, JmapSession } from "../../infra/stalwart/jmap";

const sql = createDb(testDatabaseUrl());

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let filterRules: ReturnType<typeof createFilterRulesRepo>;
let vacationSettings: ReturnType<typeof createVacationSettingsRepo>;
let sieveSyncState: ReturnType<typeof createSieveSyncStateRepo>;
let token: string;
let token2: string;
let token3: string;
let token4: string;
let token5: string;
let userId: string;
let user3Id: string;
let user4Id: string;

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
  sieveSyncState = createSieveSyncStateRepo(sql);
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

  const user4 = await users.create({
    email: `sieve-r4-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve Router User 4",
  });
  user4Id = user4.id;
  token4 = (await sessions.create(user4.id, 1)).token;
  await mailCredentials.set(user4Id, "mailbox-pw");

  // Never touches a filter: the "nothing was ever pushed" baseline.
  const user5 = await users.create({
    email: `sieve-r5-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve Router User 5",
  });
  token5 = (await sessions.create(user5.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp(jmap: JmapClient | null, reconcileCooldownMs?: number) {
  return createApp({
    sieveRouter: createSieveRouter({
      sessions,
      mailCredentials,
      filterRules,
      vacationSettings,
      sieveSyncState,
      jmap,
      reconcileCooldownMs,
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

describe("sieve sync state (GH #221)", () => {
  /** Never reconciles on read, so a test can inspect the stored state as-is. */
  const NO_RECONCILE_MS = 600_000;

  function readState(app: ReturnType<typeof makeApp>, cookie = token4) {
    return app.request("/api/mail/filters/sync-state", {
      headers: { cookie: `session=${cookie}` },
    });
  }

  it("records a rule that was saved but never applied, and exposes it as such", async () => {
    // The 502 tells the caller of THIS request that the push failed. It says
    // nothing to the next reader, who sees a filter list full of rules Stalwart
    // has never heard of — that is what this state is for.
    const app = makeApp(brokenJmap(), NO_RECONCILE_MS);
    const created = await post(app, "/api/mail/filters", { ...ruleBody, name: "unapplied" }, token4);
    expect(created.status).toBe(502);

    const state = sieveSyncStateSchema.parse(await (await readState(app)).json());
    expect(state.status).toBe("failed");
    expect(state.lastError).toBe("sieve_sync_failed");
    expect(state.attempts).toBe(1);
    expect(state.updatedAt).not.toBeNull();
  });

  it("keeps counting consecutive failures across further edits during the outage", async () => {
    const app = makeApp(brokenJmap(), NO_RECONCILE_MS);
    const second = await post(app, "/api/mail/filters", { ...ruleBody, name: "second" }, token4);
    expect(second.status).toBe(502);

    const state = sieveSyncStateSchema.parse(await (await readState(app)).json());
    expect(state.status).toBe("failed");
    expect(state.attempts).toBe(2);
  });

  it("does not push again while the cooldown is running", async () => {
    const { client, uploads } = stubJmap();
    const res = await readState(makeApp(client, NO_RECONCILE_MS));

    expect(sieveSyncStateSchema.parse(await res.json()).status).toBe("failed");
    expect(uploads).toHaveLength(0);
  });

  it("reconciles on read once Stalwart answers again", async () => {
    // The outage ended. Nobody has to remember to re-save every rule: reading
    // the state re-pushes what the database holds and settles back to synced.
    const { client, uploads } = stubJmap();
    const res = await readState(makeApp(client, 0));

    const state = sieveSyncStateSchema.parse(await res.json());
    expect(state.status).toBe("synced");
    expect(state.attempts).toBe(0);
    expect(state.lastError).toBeNull();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain("# rule: unapplied");
  });

  it("stops re-pushing once synced, however often the state is read", async () => {
    const { client, uploads } = stubJmap();
    const app = makeApp(client, 0);
    await readState(app);
    await readState(app);

    expect(uploads).toHaveLength(0);
  });

  it("reports rules stored with no mail configured as pending, not as applied", async () => {
    // Nothing is enforcing these filters: there is no Stalwart to push them to.
    // Reporting that as synced would be a lie the settings page repeats.
    const app = makeApp(null, NO_RECONCILE_MS);
    const created = await post(app, "/api/mail/filters", { ...ruleBody, name: "no mail" }, token2);
    expect(created.status).toBe(200);

    const state = sieveSyncStateSchema.parse(await (await readState(app, token2)).json());
    expect(state.status).toBe("pending");
    expect(state.lastError).toBeNull();
  });

  it("reports a user who never saved a filter as synced", async () => {
    const state = sieveSyncStateSchema.parse(
      await (await readState(makeApp(null), token5)).json(),
    );
    expect(state).toEqual({ status: "synced", attempts: 0, lastError: null, updatedAt: null });
  });

  it("records the script itself being rejected as a failure that names it", async () => {
    const invalidJmap = {
      ...stubJmap().client,
      async request(_auth: unknown, _session: unknown, calls: JmapMethodCall[]) {
        const [method] = calls[0]!;
        if (method === "Mailbox/get") {
          return [["Mailbox/get", { list: [] }, "0"]];
        }
        if (method === "SieveScript/validate") {
          return [["SieveScript/validate", { error: "syntax error" }, "0"]];
        }
        return [[method, { list: [] }, "0"]];
      },
    } as unknown as JmapClient;

    const app = makeApp(invalidJmap, NO_RECONCILE_MS);
    const res = await put(
      app,
      "/api/mail/vacation",
      { enabled: true, subject: "Out", message: "Away" },
      token4,
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("sieve_invalid");

    const state = sieveSyncStateSchema.parse(await (await readState(app)).json());
    expect(state.status).toBe("failed");
    expect(state.lastError).toBe("sieve_invalid");
  });
});

// GH #36. `urn:ietf:params:jmap:sieve` is an EXTENSION: a JMAP provider is free
// not to implement it, and this server used to assume it — putting it in every
// `using` array, so against such a provider every filter save and every
// vacation change came back as a generic JMAP failure with nothing anywhere
// saying the feature simply does not exist there.
describe("sieve capability (GH #36)", () => {
  const NO_RECONCILE_MS = 600_000;

  /** A provider whose session advertises everything EXCEPT the Sieve extension. */
  function sieveLessJmap(): { client: JmapClient; methods: string[] } {
    const methods: string[] = [];
    const client = {
      async getSession(): Promise<JmapSession> {
        return {
          apiUrl: "http://other/jmap/api",
          accountId: "acc1",
          eventSourceUrl: "",
          uploadUrl: "http://other/upload/{accountId}/",
          downloadUrl: "",
          capabilities: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        };
      },
      async request(_auth: unknown, _session: unknown, calls: JmapMethodCall[]) {
        methods.push(calls[0]![0]);
        return [[calls[0]![0], { list: [] }, "0"]];
      },
      async uploadBlob() {
        methods.push("uploadBlob");
        return "blob1";
      },
    } as unknown as JmapClient;
    return { client, methods };
  }

  /** A provider that does advertise it — the Stalwart case, unchanged. */
  function sieveCapableJmap(): JmapClient {
    return {
      ...stubJmap().client,
      async getSession(): Promise<JmapSession> {
        return {
          apiUrl: "http://stalwart/jmap/api",
          accountId: "acc1",
          eventSourceUrl: "",
          uploadUrl: "http://stalwart/upload/{accountId}/",
          downloadUrl: "",
          capabilities: [
            "urn:ietf:params:jmap:core",
            "urn:ietf:params:jmap:mail",
            "urn:ietf:params:jmap:sieve",
          ],
        };
      },
    } as unknown as JmapClient;
  }

  function readCapability(app: ReturnType<typeof makeApp>, cookie = token4) {
    return app.request("/api/mail/sieve/capability", {
      headers: { cookie: `session=${cookie}` },
    });
  }

  it("requires a session", async () => {
    const res = await makeApp(null).request("/api/mail/sieve/capability");
    expect(res.status).toBe(401);
  });

  it("reports a provider that advertises the extension as supported", async () => {
    const res = await readCapability(makeApp(sieveCapableJmap()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ supported: true });
  });

  it("reports a provider that does not advertise it as unsupported", async () => {
    const { client } = sieveLessJmap();
    const res = await readCapability(makeApp(client));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ supported: false });
  });

  // The three "not known" cases below all answer supported. A wrong yes costs
  // the same failure the user got before this existed; a wrong no would hide a
  // working feature and every rule already saved behind it.
  it("reports supported when no mail backend is configured at all", async () => {
    expect(await (await readCapability(makeApp(null))).json()).toEqual({ supported: true });
  });

  it("reports supported when the user has no mailbox linked yet", async () => {
    const { client } = sieveLessJmap();
    // token2 — a user with no mail credentials: there is no session to ask.
    expect(await (await readCapability(makeApp(client), token2)).json()).toEqual({
      supported: true,
    });
  });

  it("reports supported when the provider cannot be reached", async () => {
    expect(await (await readCapability(makeApp(brokenJmap()))).json()).toEqual({
      supported: true,
    });
  });

  it("does not send a single Sieve request to a provider that cannot answer one", async () => {
    const { client, methods } = sieveLessJmap();
    const app = makeApp(client, NO_RECONCILE_MS);

    const res = await put(
      app,
      "/api/mail/vacation",
      { enabled: true, subject: "Out", message: "Away" },
      token4,
    );

    // The rule is still stored — the local write is not the thing that cannot
    // work — but the push is refused up front, with a code that says why.
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("sieve_unsupported");
    expect(methods).toEqual([]);
  });

  it("records the unsupported push as a failure that names itself", async () => {
    const { client } = sieveLessJmap();
    const app = makeApp(client, NO_RECONCILE_MS);

    await put(app, "/api/mail/vacation", { enabled: true, message: "Away" }, token4);

    const state = sieveSyncStateSchema.parse(
      await (
        await app.request("/api/mail/filters/sync-state", {
          headers: { cookie: `session=${token4}` },
        })
      ).json(),
    );
    expect(state.status).toBe("failed");
    // Distinct from sieve_sync_failed on purpose: that one is worth retrying
    // and this one never will be.
    expect(state.lastError).toBe("sieve_unsupported");
  });
});
