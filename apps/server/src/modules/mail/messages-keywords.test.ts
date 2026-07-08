import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { JmapClient, JmapMethodCall } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let calls: JmapMethodCall[] = [];

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
    return [
      ["Email/query", { ids: [], total: 0, position: 0 }, "q"],
      ["Email/get", { list: [] }, "g"],
    ];
  },
  uploadBlob: async () => "blob-id",
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
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap,
    }),
  });
}

describe("GET /api/mail/messages — keyword filters", () => {
  it("filters by a single keyword combined with the mailbox", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=mb1&hasKeyword=%24flagged",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({
      operator: "AND",
      conditions: [{ inMailbox: "mb1" }, { hasKeyword: "$flagged" }],
    });
  });

  it("allows a cross-mailbox query with only hasKeyword", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?hasKeyword=%24flagged",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({ hasKeyword: "$flagged" });
  });

  it("ANDs multiple comma-separated keywords", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=mb1&hasKeyword=%24flagged,urgent",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "mb1" },
        { hasKeyword: "$flagged" },
        { hasKeyword: "urgent" },
      ],
    });
  });

  it("excludes a mailbox via excludeMailboxId combined with hasKeyword", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?hasKeyword=%24flagged&excludeMailboxId=mb-archive",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({
      operator: "AND",
      conditions: [
        { hasKeyword: "$flagged" },
        { operator: "NOT", conditions: [{ inMailbox: "mb-archive" }] },
      ],
    });
  });

  it("rejects a request with neither mailboxId nor hasKeyword", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/messages", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_query");
  });

  it("rejects keywords with an invalid charset", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=mb1&hasKeyword=bad%20keyword",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_query");
  });
});
