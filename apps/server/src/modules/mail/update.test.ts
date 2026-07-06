import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { JmapClient, JmapMethodCall } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let calls: JmapMethodCall[] = [];
let nextResponse: { updated?: Record<string, unknown>; notUpdated?: Record<string, unknown> } = {
  updated: { e1: null },
};

const stubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
  }),
  request: async (_auth, _session, methodCalls) => {
    calls = methodCalls;
    return [["Email/set", nextResponse, "s"]];
  },
};

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let token: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  sessions = createSessionStore(sql);

  const withCred = await users.create({
    email: `m-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Mail User",
  });
  await mailCredentials.set(withCred.id, "mailbox-pw");
  token = (await sessions.create(withCred.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp(jmap: JmapClient | null) {
  return createApp({
    mailRouter: createMailRouter({ sessions, mailCredentials, jmap }),
  });
}

describe("PATCH /api/mail/messages/:id", () => {
  it("translates keywords into per-key JMAP patches", async () => {
    nextResponse = { updated: { e1: null } };
    const res = await makeApp(stubJmap).request("/api/mail/messages/e1", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ keywords: { $seen: true, "label-x": false } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [setCall] = calls;
    expect(setCall?.[0]).toBe("Email/set");
    const params = setCall?.[1] as { accountId: string; update: Record<string, unknown> };
    expect(params.accountId).toBe("acc-1");
    expect(params.update).toEqual({
      e1: { "keywords/$seen": true, "keywords/label-x": null },
    });
  });

  it("sends mailboxIds as a full replacement object", async () => {
    nextResponse = { updated: { e1: null } };
    const res = await makeApp(stubJmap).request("/api/mail/messages/e1", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mailboxIds: { mb2: true } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [setCall] = calls;
    const params = setCall?.[1] as { update: Record<string, unknown> };
    expect(params.update).toEqual({ e1: { mailboxIds: { mb2: true } } });
  });

  it("returns 409 update_failed when the JMAP response reports notUpdated", async () => {
    nextResponse = { notUpdated: { e1: { type: "notFound" } } };
    const res = await makeApp(stubJmap).request("/api/mail/messages/e1", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ keywords: { $seen: true } }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("update_failed");
  });

  it("returns 400 invalid_body for an empty body", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/messages/e1", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 400 invalid_body for malformed JSON", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/messages/e1", {
      method: "PATCH",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });
});
