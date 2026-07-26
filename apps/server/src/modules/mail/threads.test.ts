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
              messageId: null,
              references: null,
              inReplyTo: null,
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
                { blobId: "blob1", name: "file.pdf", type: "application/pdf", size: 100, cid: "logo123" },
                { blobId: "blob2", name: "image.png", type: "image/png", size: 50 },
              ],
              // RFC 8621: JMAP returns message ids in parsed form — angle
              // brackets and CFWS removed.
              messageId: ["e1@x.com"],
              references: ["root@x.com"],
              inReplyTo: ["root@x.com"],
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
    // e2 carries no Message-ID/References/In-Reply-To headers in the stub —
    // JMAP models that as null (GH #120).
    expect(e2?.messageId).toBeNull();
    expect(e2?.references).toBeNull();
    expect(e2?.inReplyTo).toBeNull();

    const e1 = body.emails.find((e) => e.id === "e1");
    expect(e1?.bodyHtml).toBeNull();
    expect(e1?.bodyText).toBe("plain content");
    expect(e1?.attachments).toEqual([
      { blobId: "blob1", name: "file.pdf", type: "application/pdf", size: 100, cid: "logo123" },
      { blobId: "blob2", name: "image.png", type: "image/png", size: 50, cid: null },
    ]);
    expect(e1?.cc).toEqual([]);
    expect(e1?.replyTo).toEqual([]);
    expect(e1?.messageId).toEqual(["e1@x.com"]);
    expect(e1?.references).toEqual(["root@x.com"]);
    expect(e1?.inReplyTo).toEqual(["root@x.com"]);

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
    expect((getCall?.[1] as { properties: string[] }).properties).toEqual(
      expect.arrayContaining(["messageId", "references", "inReplyTo"]),
    );
  });

  it("returns 404 when the thread is not found", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/threads/unknown", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});

// GH #136: sender-authenticity verdict, wired end to end through the router
// rather than just deriveSenderAuthVerdict in isolation (see
// sender-auth.test.ts for the exhaustive parsing/verdict cases). Kept as its
// own stub/describe block, entirely separate from the fixture above, so the
// pre-existing GH #120 test and its stub data above are left untouched.
const senderAuthStubJmap: JmapClient = {
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
      ["Thread/get", { list: [{ id: "t2", emailIds: ["auth-pass", "auth-none"] }] }, "t"],
      [
        "Email/get",
        {
          list: [
            {
              id: "auth-pass",
              threadId: "t2",
              mailboxIds: { mb1: true },
              from: [{ name: "Carla Ibarra", email: "carla@partner.test" }],
              to: [],
              subject: "Authenticated sender",
              receivedAt: "2026-07-06T10:00:00Z",
              preview: "",
              keywords: {},
              hasAttachment: false,
              size: 10,
              messageId: null,
              references: null,
              inReplyTo: null,
              // A genuine DMARC pass, positioned first (topmost) as a real
              // receiving server would add it.
              headers: [
                { name: "Received", value: " from mx.partner.test by mail.cefiro.test" },
                {
                  name: "Authentication-Results",
                  value: " mail.cefiro.test; dmarc=pass (p=reject) header.from=partner.test",
                },
                { name: "From", value: " Carla Ibarra <carla@partner.test>" },
              ],
            },
            {
              id: "auth-none",
              threadId: "t2",
              mailboxIds: { mb1: true },
              from: [{ name: "Cefiro Seguridad", email: "cuentas@cefiro-verificacion-segura.test" }],
              to: [],
              subject: "Spoofed sender",
              receivedAt: "2026-07-06T11:00:00Z",
              preview: "",
              keywords: {},
              hasAttachment: false,
              size: 10,
              messageId: null,
              references: null,
              inReplyTo: null,
              // Verbatim shape observed on the live e2e Stalwart fixture's
              // spoofed phishing message (GH #136/#137 investigation):
              // dmarc=none, never a pass.
              headers: [
                {
                  name: "Authentication-Results",
                  value:
                    " mail.cefiro.test; spf=none smtp.mailfrom=cuentas@cefiro-verificacion-segura.test; " +
                    "dmarc=none header.from=cefiro-verificacion-segura.test policy.dmarc=none",
                },
              ],
            },
          ],
        },
        "g",
      ],
    ];
  },
  uploadBlob: async () => "blob-id",
};

describe("GET /api/mail/threads/:threadId — sender authentication (GH #136)", () => {
  it("requests the headers property and maps a genuine DMARC pass to senderAuth 'pass'", async () => {
    const res = await makeApp(senderAuthStubJmap).request("/api/mail/threads/t2", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = threadDetailSchema.parse(await res.json());

    const authPass = body.emails.find((e) => e.id === "auth-pass");
    expect(authPass?.senderAuth).toBe("pass");

    const [, getCall] = calls;
    expect((getCall?.[1] as { properties: string[] }).properties).toEqual(
      expect.arrayContaining(["headers"]),
    );
  });

  it("maps a non-pass DMARC result (e.g. 'none', the spoofed-sender fixture shape) to senderAuth 'unknown', never 'pass'", async () => {
    const res = await makeApp(senderAuthStubJmap).request("/api/mail/threads/t2", {
      headers: { cookie: `session=${token}` },
    });
    const body = threadDetailSchema.parse(await res.json());

    const authNone = body.emails.find((e) => e.id === "auth-none");
    expect(authNone?.senderAuth).toBe("unknown");
  });
});
