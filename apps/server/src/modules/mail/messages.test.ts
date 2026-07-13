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
import { messagesPageSchema } from "@webmail/shared";
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
      ["Email/query", { ids: ["e2", "e1"], total: 2, position: 0 }, "q"],
      [
        "Email/get",
        {
          list: [
            {
              id: "e1",
              threadId: "t1",
              mailboxIds: { mb1: true },
              from: [{ name: "Ana", email: "a@x.com" }],
              to: [],
              subject: "One",
              receivedAt: "2026-07-05T10:00:00Z",
              preview: "p1",
              keywords: { $seen: true },
              hasAttachment: false,
              size: 10,
            },
            {
              id: "e2",
              threadId: "t2",
              mailboxIds: { mb1: true },
              to: [{ email: "b@x.com" }],
              receivedAt: "2026-07-06T10:00:00Z",
              size: 20,
            },
          ],
        },
        "g",
      ],
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

describe("GET /api/mail/messages", () => {
  it("requires mailboxId", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/messages", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_query");
  });

  it("returns a messages page ordered by the query's ids and parsing the shared schema", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/messages?mailboxId=mb1", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = messagesPageSchema.parse(await res.json());
    expect(body.total).toBe(2);
    expect(body.emails.map((e) => e.id)).toEqual(["e2", "e1"]);

    const e2 = body.emails.find((e) => e.id === "e2");
    expect(e2?.subject).toBe("");
    expect(e2?.from).toEqual([]);
    expect(e2?.keywords).toEqual({});
    expect(e2?.hasAttachment).toBe(false);
    expect(e2?.mailboxIds).toEqual(["mb1"]);

    const [queryCall, getCall] = calls;
    expect(queryCall?.[0]).toBe("Email/query");
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({ inMailbox: "mb1" });
    expect(getCall?.[0]).toBe("Email/get");
    expect((getCall?.[1] as { "#ids": unknown })["#ids"]).toEqual({
      resultOf: "q",
      name: "Email/query",
      path: "/ids",
    });
  });

  it("adds a text filter when query is provided", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=mb1&query=urgent",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { filter: unknown }).filter).toEqual({
      operator: "AND",
      conditions: [{ inMailbox: "mb1" }, { text: "urgent" }],
    });
  });

  it("clamps limit to a max of 100", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=mb1&limit=500",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    expect((queryCall?.[1] as { limit: number }).limit).toBe(100);
  });

  it("clamps negative position and limit to safe minimums", async () => {
    const res = await makeApp(stubJmap).request(
      "/api/mail/messages?mailboxId=mb1&position=-10&limit=-5",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const [queryCall] = calls;
    const params = queryCall?.[1] as { position: number; limit: number };
    expect(params.position).toBe(0);
    expect(params.limit).toBe(1);
  });
});
