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
import { threadDetailSchema } from "@webmail/shared";
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
    const threadCall = methodCalls[0];
    const ids = (threadCall?.[1] as { ids: string[] }).ids;
    if (ids[0] !== "t1") {
      return [
        ["Thread/get", { list: [] }, "t"],
        ["Email/get", { list: [] }, "g"],
      ];
    }
    return [
      ["Thread/get", { list: [{ id: "t1", emailIds: ["e2", "e1"] }] }, "t"],
      [
        "Email/get",
        {
          list: [
            {
              id: "e2",
              threadId: "t1",
              mailboxIds: { mb1: true },
              from: [{ name: "Ana", email: "a@x.com" }],
              to: [],
              subject: "Two",
              receivedAt: "2026-07-06T10:00:00Z",
              preview: "p2",
              keywords: {},
              hasAttachment: false,
              size: 30,
              htmlBody: [{ partId: "1" }, { partId: "2" }],
              bodyValues: {
                "1": { value: "<p>Hello " },
                "2": { value: "World</p>" },
              },
            },
            {
              id: "e1",
              threadId: "t1",
              mailboxIds: { mb1: true },
              from: [{ name: "Bob", email: "b@x.com" }],
              to: [],
              subject: "One",
              receivedAt: "2026-07-05T09:00:00Z",
              preview: "p1",
              keywords: {},
              hasAttachment: true,
              size: 40,
              textBody: [{ partId: "3" }],
              bodyValues: {
                "3": { value: "plain content" },
              },
              attachments: [
                { blobId: "blob1", name: "file.pdf", type: "application/pdf", size: 100 },
              ],
            },
          ],
        },
        "g",
      ],
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
    mailRouter: createMailRouter({ sessions, mailCredentials, jmap }),
  });
}

describe("GET /api/mail/threads/:threadId", () => {
  it("returns the thread with emails sorted oldest-first and parses the shared schema", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/threads/t1", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = threadDetailSchema.parse(await res.json());
    expect(body.id).toBe("t1");
    expect(body.emails.map((e) => e.id)).toEqual(["e1", "e2"]);

    const e2 = body.emails.find((e) => e.id === "e2");
    expect(e2?.bodyHtml).toBe("<p>Hello World</p>");
    expect(e2?.bodyText).toBeNull();
    expect(e2?.attachments).toEqual([]);

    const e1 = body.emails.find((e) => e.id === "e1");
    expect(e1?.bodyHtml).toBeNull();
    expect(e1?.bodyText).toBe("plain content");
    expect(e1?.attachments).toEqual([
      { blobId: "blob1", name: "file.pdf", type: "application/pdf", size: 100 },
    ]);
    expect(e1?.cc).toEqual([]);
    expect(e1?.replyTo).toEqual([]);

    const [threadCall, getCall] = calls;
    expect(threadCall?.[0]).toBe("Thread/get");
    expect((threadCall?.[1] as { ids: string[] }).ids).toEqual(["t1"]);
    expect(getCall?.[0]).toBe("Email/get");
    expect((getCall?.[1] as { "#ids": unknown })["#ids"]).toEqual({
      resultOf: "t",
      name: "Thread/get",
      path: "/list/*/emailIds",
    });
    expect((getCall?.[1] as { fetchHTMLBodyValues: boolean }).fetchHTMLBodyValues).toBe(true);
    expect((getCall?.[1] as { fetchTextBodyValues: boolean }).fetchTextBodyValues).toBe(true);
    expect((getCall?.[1] as { maxBodyValueBytes: number }).maxBodyValueBytes).toBe(524288);
  });

  it("returns 404 when the thread is not found", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/threads/unknown", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});
