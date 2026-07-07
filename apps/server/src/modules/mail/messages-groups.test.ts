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

describe("GET /api/mail/messages — recipient filters", () => {
  it("adds a recipient match filter when `to` is provided", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=inbox&to=soporte@x.com",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "inbox" },
        {
          operator: "OR",
          conditions: [{ to: "soporte@x.com" }, { cc: "soporte@x.com" }],
        },
      ],
    });
  });

  it("adds a NOT filter for each address when `excludeTo` is a comma-separated list", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=inbox&excludeTo=soporte@x.com,ventas@x.com",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "inbox" },
        {
          operator: "NOT",
          conditions: [
            {
              operator: "OR",
              conditions: [{ to: "soporte@x.com" }, { cc: "soporte@x.com" }],
            },
            {
              operator: "OR",
              conditions: [{ to: "ventas@x.com" }, { cc: "ventas@x.com" }],
            },
          ],
        },
      ],
    });
  });

  it("leaves the filter unchanged when neither `to` nor `excludeTo` is provided", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/messages?mailboxId=inbox", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({ inMailbox: "inbox" });
  });

  it("combines query + to into an AND filter", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=inbox&query=urgent&to=soporte@x.com",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "inbox" },
        { text: "urgent" },
        {
          operator: "OR",
          conditions: [{ to: "soporte@x.com" }, { cc: "soporte@x.com" }],
        },
      ],
    });
  });
});
