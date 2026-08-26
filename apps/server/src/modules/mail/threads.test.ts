import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import { createSentRecipientsRepo, type SentRecipientsRepo } from "../../infra/repos/sent-recipients";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import { threadDetailSchema } from "@webmail/shared";
import type { JmapClient, JmapMethodCall } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

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
let users: ReturnType<typeof createUsersRepo>;
let token: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  users = createUsersRepo(sql);
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

// GH #152: the sender-authenticity fixtures below stamp `mail.cefiro.test` as
// their authserv-id, so tests that assert a verdict pass that as the configured
// id. Omitting it (undefined) exercises the fail-safe path — every verdict
// "unknown" — which is why it is a plain optional, not a defaulted, parameter:
// a default would swallow an explicit `undefined` and hide that path.
//
// GH #314: `sentRecipients` is optional the same way — omitted, Tier A of the
// sender-trust indicator is simply never asserted and no backfill runs, which
// is what keeps every test above byte-identical in what it exercises.
function makeApp(jmap: JmapClient | null, authServId?: string, sentRecipients?: SentRecipientsRepo) {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap,
      authServId,
      sentRecipients,
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
    const res = await makeApp(senderAuthStubJmap, "mail.cefiro.test").request("/api/mail/threads/t2", {
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
    const res = await makeApp(senderAuthStubJmap, "mail.cefiro.test").request("/api/mail/threads/t2", {
      headers: { cookie: `session=${token}` },
    });
    const body = threadDetailSchema.parse(await res.json());

    const authNone = body.emails.find((e) => e.id === "auth-none");
    expect(authNone?.senderAuth).toBe("unknown");
  });
});

// GH #152: the authenticated-submission exploit, wired end to end. On
// authenticated submission this server adds no Authentication-Results header of
// its own, so a header the SENDER forged is the first and only one. The old
// #136 "trust the first" behaviour handed that forged dmarc=pass a green
// "verified sender" badge on a message spoofed from an ordinary mailbox
// credential (reproduced live). Its authserv-id does not match ours, so the
// verdict must be "unknown".
const submissionExploitStubJmap: JmapClient = {
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
      ["Thread/get", { list: [{ id: "t4", emailIds: ["forged", "genuine"] }] }, "t"],
      [
        "Email/get",
        {
          list: [
            {
              id: "forged",
              threadId: "t4",
              mailboxIds: { mb1: true },
              from: [{ name: "Banco Seguro", email: "no-reply@banco-seguro.test" }],
              to: [],
              subject: "Su cuenta ha sido bloqueada",
              receivedAt: "2026-07-06T10:00:00Z",
              preview: "",
              keywords: {},
              hasAttachment: false,
              size: 10,
              messageId: null,
              references: null,
              inReplyTo: null,
              // The forged header is first and only, and its authserv-id is NOT
              // this deployment's — a sender-suppliable value.
              headers: [
                { name: "From", value: ' "Banco Seguro" <no-reply@banco-seguro.test>' },
                {
                  name: "Authentication-Results",
                  value: " forged-mta.attacker.test; dmarc=pass header.from=banco-seguro.test",
                },
              ],
            },
            {
              id: "genuine",
              threadId: "t4",
              mailboxIds: { mb1: true },
              from: [{ name: "Carla Ibarra", email: "carla@partner.test" }],
              to: [],
              subject: "Genuine",
              receivedAt: "2026-07-06T11:00:00Z",
              preview: "",
              keywords: {},
              hasAttachment: false,
              size: 10,
              messageId: null,
              references: null,
              inReplyTo: null,
              headers: [
                {
                  name: "Authentication-Results",
                  value: " mail.cefiro.test; dmarc=pass (p=reject) header.from=partner.test",
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

describe("GET /api/mail/threads/:threadId — authenticated-submission exploit (GH #152)", () => {
  it("does NOT trust a forged Authentication-Results whose authserv-id is not ours — verdict 'unknown', not 'pass'", async () => {
    const res = await makeApp(submissionExploitStubJmap, "mail.cefiro.test").request(
      "/api/mail/threads/t4",
      { headers: { cookie: `session=${token}` } },
    );
    expect(res.status).toBe(200);
    const body = threadDetailSchema.parse(await res.json());

    const forged = body.emails.find((e) => e.id === "forged");
    expect(forged?.senderAuth).toBe("unknown");
    expect(forged?.senderAuth).not.toBe("pass");

    // The genuine header (matching authserv-id) is still honoured.
    const genuine = body.emails.find((e) => e.id === "genuine");
    expect(genuine?.senderAuth).toBe("pass");
  });

  it("degrades every verdict to 'unknown' when no authserv-id is configured (fail-safe)", async () => {
    // No authserv-id configured (parameter omitted) — the fail-safe path.
    const res = await makeApp(submissionExploitStubJmap).request("/api/mail/threads/t4", {
      headers: { cookie: `session=${token}` },
    });
    const body = threadDetailSchema.parse(await res.json());

    // Even the genuine DMARC pass asserts nothing without JMAP_AUTHSERV_ID set.
    expect(body.emails.find((e) => e.id === "genuine")?.senderAuth).toBe("unknown");
    expect(body.emails.find((e) => e.id === "forged")?.senderAuth).toBe("unknown");
  });
});

// GH #140: JMAP marks a body value it had to cut with `isTruncated` (RFC 8621
// §4.1.4). The router used to read only `.value` and drop that flag, so a
// message cut at the maxBodyValueBytes budget reached the client looking
// exactly like a message that genuinely ends there. Own stub/describe block,
// leaving the fixtures above untouched.
const truncatedStubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
  }),
  request: async (_auth, _session, methodCalls) => {
    calls = methodCalls;
    const base = {
      threadId: "t3",
      mailboxIds: { mb1: true },
      from: [{ name: "Ana", email: "ana@x.test" }],
      to: [],
      subject: "Long thread",
      receivedAt: "2026-07-07T10:00:00Z",
      preview: "",
      keywords: {},
      hasAttachment: false,
      size: 10,
      messageId: null,
      references: null,
      inReplyTo: null,
    };
    return [
      ["Thread/get", { list: [{ id: "t3", emailIds: ["cut-html", "whole", "cut-text"] }] }, "t"],
      [
        "Email/get",
        {
          list: [
            {
              ...base,
              id: "cut-html",
              htmlBody: [{ partId: "1" }, { partId: "2" }],
              bodyValues: {
                "1": { value: "<p>first part</p>" },
                // Only the SECOND part hit the ceiling — the flag has to be
                // read per body value, not just off the first one.
                "2": { value: "<p>cut here", isTruncated: true },
              },
            },
            {
              ...base,
              id: "whole",
              htmlBody: [{ partId: "3" }],
              bodyValues: { "3": { value: "<p>complete</p>", isTruncated: false } },
            },
            {
              ...base,
              id: "cut-text",
              textBody: [{ partId: "4" }],
              // A server that simply omits the flag must read as "not
              // truncated", never as unknown-and-therefore-suspect.
              bodyValues: { "4": { value: "plain, complete" } },
            },
          ],
        },
        "g",
      ],
    ];
  },
  uploadBlob: async () => "blob-id",
};

describe("GET /api/mail/threads/:threadId — truncated bodies (GH #140)", () => {
  it("reports a body JMAP had to cut as truncated, without losing the part it did return", async () => {
    const res = await makeApp(truncatedStubJmap).request("/api/mail/threads/t3", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = threadDetailSchema.parse(await res.json());

    const cut = body.emails.find((e) => e.id === "cut-html");
    expect(cut?.bodyTruncated).toBe(true);
    expect(cut?.bodyHtml).toBe("<p>first part</p><p>cut here");
  });

  it("leaves a complete body unflagged", async () => {
    const res = await makeApp(truncatedStubJmap).request("/api/mail/threads/t3", {
      headers: { cookie: `session=${token}` },
    });
    const body = threadDetailSchema.parse(await res.json());

    expect(body.emails.find((e) => e.id === "whole")?.bodyTruncated).toBe(false);
  });

  it("treats an omitted isTruncated as not truncated", async () => {
    const res = await makeApp(truncatedStubJmap).request("/api/mail/threads/t3", {
      headers: { cookie: `session=${token}` },
    });
    const body = threadDetailSchema.parse(await res.json());

    const plain = body.emails.find((e) => e.id === "cut-text");
    expect(plain?.bodyTruncated).toBe(false);
    expect(plain?.bodyText).toBe("plain, complete");
  });

  it("still asks JMAP for a bounded body budget — the flag reports the cut, it does not remove it", async () => {
    await makeApp(truncatedStubJmap).request("/api/mail/threads/t3", {
      headers: { cookie: `session=${token}` },
    });
    const [, getCall] = calls;
    expect((getCall?.[1] as { maxBodyValueBytes: number }).maxBodyValueBytes).toBe(524288);
  });
});

// GH #314: the sender-trust tiers resolved end to end through the thread
// route. Each message below is one row of the security contract; the exact
// From address/domain the badge is tied to is asserted alongside the tier so
// a mismatch can never be hidden by a coincidental "known". Own stub (it must
// also answer the one-time Sent backfill's Mailbox/get + Email/query batches)
// and own user per test, so the per-user sent_recipients store and the
// backfill marker start empty every time.
// GH #314 (JD-1): a DMARC pass is evidence about the domain DMARC evaluated —
// the `header.from=` propspec — so every positive fixture below stamps the
// domain of its OWN From address. A fixture that reused one shared
// `header.from=partner.test` for every sender would assert exactly the binding
// bug this pins: a genuine pass for one domain vouching for another.
function passHeader(headerFromDomain: string) {
  return {
    name: "Authentication-Results",
    value: ` mail.cefiro.test; dmarc=pass (p=reject) header.from=${headerFromDomain}`,
  };
}
const FAIL_HEADER = {
  name: "Authentication-Results",
  value: " mail.cefiro.test; dmarc=fail (p=reject) header.from=partner.test",
};
const NONE_HEADER = {
  name: "Authentication-Results",
  value: " mail.cefiro.test; dmarc=none header.from=partner.test",
};
const PASS_HEADER_NO_FROM = {
  name: "Authentication-Results",
  value: " mail.cefiro.test; dmarc=pass (p=reject)",
};

function trustEmail(id: string, from: string | string[], header: { name: string; value: string } | null) {
  return {
    id,
    threadId: "t5",
    mailboxIds: { mb1: true },
    from: (Array.isArray(from) ? from : [from]).map((email) => ({ name: null, email })),
    to: [],
    subject: id,
    receivedAt: "2026-07-06T10:00:00Z",
    preview: "",
    keywords: {},
    hasAttachment: false,
    size: 10,
    messageId: null,
    references: null,
    inReplyTo: null,
    headers: header ? [header] : [],
  };
}

const TRUST_THREAD = [
  trustEmail("known-pass", "Ana@Partner.Test", passHeader("partner.test")),
  trustEmail("known-fail", "ana@partner.test", FAIL_HEADER),
  trustEmail("sibling-pass", "bob@partner.test", passHeader("partner.test")),
  trustEmail("seed-pass", "notifications@noreply.github.com", passHeader("noreply.github.com")),
  trustEmail("seed-none", "noreply@github.com", NONE_HEADER),
  trustEmail("seed-no-header", "noreply@github.com", null),
  trustEmail("lookalike-pass", "noreply@githiib.com", passHeader("githiib.com")),
  trustEmail("user-domain-pass", "billing@invoices.acme-partner.test", passHeader("invoices.acme-partner.test")),
  trustEmail("both-pass", "support@github.com", passHeader("github.com")),
  trustEmail("backfilled-pass", "carla@backfilled.test", passHeader("backfilled.test")),
  // The binding cases: each carries a genuine, trusted DMARC pass that says
  // nothing about the address the reader is shown.
  trustEmail("mismatched-from-pass", "ana@partner.test", passHeader("attacker.test")),
  trustEmail("no-header-from-pass", "ana@partner.test", PASS_HEADER_NO_FROM),
  trustEmail("two-from-pass", ["ana@partner.test", "evil@attacker.test"], passHeader("partner.test")),
];

function makeTrustStubJmap(input: {
  calls: JmapMethodCall[][];
  sentMailbox?: boolean;
  backfillThrows?: boolean;
}): JmapClient {
  return {
    getSession: async () => ({
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    }),
    request: async (_auth, _session, methodCalls) => {
      input.calls.push(methodCalls);
      const name = methodCalls[0]?.[0];
      if (name === "Mailbox/get") {
        if (input.backfillThrows) throw new Error("boom: simulated JMAP failure");
        const list = input.sentMailbox === false ? [{ id: "mb1", role: "inbox" }] : [
          { id: "mb1", role: "inbox" },
          { id: "mb-sent", role: "sent" },
        ];
        return [["Mailbox/get", { list }, "mb"]];
      }
      if (name === "Email/query") {
        return [
          ["Email/query", { ids: ["s1"], position: 0 }, "q"],
          ["Email/get", { list: [{ id: "s1", to: [{ email: "carla@backfilled.test" }] }] }, "g"],
        ];
      }
      return [
        ["Thread/get", { list: [{ id: "t5", emailIds: TRUST_THREAD.map((e) => e.id) }] }, "t"],
        ["Email/get", { list: TRUST_THREAD }, "g"],
      ];
    },
    uploadBlob: async () => "blob-id",
  };
}

async function trustUser() {
  const user = await users.create({
    email: `trust-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Trust User",
  });
  await mailCredentials.set(user.id, "mailbox-pw");
  const session = await sessions.create(user.id, 1);
  const sentRecipients = createSentRecipientsRepo(sql);
  await sentRecipients.record(user.id, ["ana@partner.test", "support@github.com"]);
  await createUserPreferencesRepo(sql).merge(user.id, { trustedServices: ["acme-partner.test"] });
  return { userId: user.id, token: session.token, sentRecipients };
}

describe("GET /api/mail/threads/:threadId — sender trust (GH #314)", () => {
  async function readTrust(jmap: JmapClient, user: Awaited<ReturnType<typeof trustUser>>) {
    const res = await makeApp(jmap, "mail.cefiro.test", user.sentRecipients).request("/api/mail/threads/t5", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);
    const body = threadDetailSchema.parse(await res.json());
    return Object.fromEntries(body.emails.map((e) => [e.id, { trust: e.senderTrust, from: e.from[0]?.email }]));
  }

  it("resolves every tier exactly as the security contract says", async () => {
    const user = await trustUser();
    const trust = await readTrust(makeTrustStubJmap({ calls: [] }), user);

    // Tier A: DMARC pass + the user has written to this exact address.
    expect(trust["known-pass"]).toEqual({ trust: "known", from: "Ana@Partner.Test" });
    // DMARC fail wins over everything: no positive mark, ever.
    expect(trust["known-fail"]).toEqual({ trust: "none", from: "ana@partner.test" });
    // Same domain, different mailbox: not the address the user wrote to.
    expect(trust["sibling-pass"]).toEqual({ trust: "none", from: "bob@partner.test" });
    // Tier B via the curated seed, subdomain match.
    expect(trust["seed-pass"]).toEqual({ trust: "trusted-service", from: "notifications@noreply.github.com" });
    // A seed domain without a DMARC pass is nothing — exactly the spoof case.
    expect(trust["seed-none"]).toEqual({ trust: "none", from: "noreply@github.com" });
    expect(trust["seed-no-header"]).toEqual({ trust: "none", from: "noreply@github.com" });
    // Look-alike domain: DMARC passes for githiib.com, which is not trusted.
    expect(trust["lookalike-pass"]).toEqual({ trust: "none", from: "noreply@githiib.com" });
    // Tier B via the user's own confirmed list, subdomain match.
    expect(trust["user-domain-pass"]).toEqual({
      trust: "trusted-service",
      from: "billing@invoices.acme-partner.test",
    });
    // Both tiers apply: trusted-service wins.
    expect(trust["both-pass"]).toEqual({ trust: "trusted-service", from: "support@github.com" });
  });

  // GH #314 (JD-1): the tier is tied to `from[0]`, so the DMARC pass behind it
  // must be tied to that same address. Each case below carries a genuine pass
  // from our own authserv-id that simply does not vouch for what the reader sees.
  it("asserts no tier when the trusted DMARC pass is not bound to the visible From address", async () => {
    const user = await trustUser();
    const trust = await readTrust(makeTrustStubJmap({ calls: [] }), user);

    // DMARC evaluated attacker.test; the reader is shown a known correspondent.
    expect(trust["mismatched-from-pass"]).toEqual({ trust: "none", from: "ana@partner.test" });
    // No header.from at all: the pass names no domain, so it binds to none.
    expect(trust["no-header-from-pass"]).toEqual({ trust: "none", from: "ana@partner.test" });
    // Two From addresses: DMARC evaluated one, the reader is shown another.
    expect(trust["two-from-pass"]).toEqual({ trust: "none", from: "ana@partner.test" });
  });

  it("keeps every tier at 'none' when no authserv-id is configured (fail-safe, like senderAuth)", async () => {
    const user = await trustUser();
    const res = await makeApp(makeTrustStubJmap({ calls: [] }), undefined, user.sentRecipients).request(
      "/api/mail/threads/t5",
      { headers: { cookie: `session=${user.token}` } },
    );
    const body = threadDetailSchema.parse(await res.json());
    expect(body.emails.every((e) => e.senderTrust === "none")).toBe(true);
  });

  it("answers Tier A with ONE sent_recipients query for the whole thread, not one per message", async () => {
    const user = await trustUser();
    let hasCalls = 0;
    const counting: SentRecipientsRepo = {
      ...user.sentRecipients,
      has: (userId, emails) => {
        hasCalls += 1;
        return user.sentRecipients.has(userId, emails);
      },
    };
    const res = await makeApp(makeTrustStubJmap({ calls: [] }), "mail.cefiro.test", counting).request(
      "/api/mail/threads/t5",
      { headers: { cookie: `session=${user.token}` } },
    );
    expect(res.status).toBe(200);
    expect(hasCalls).toBe(1);
  });

  it("runs the one-time Sent backfill on the first read, so a pre-existing correspondent is 'known'", async () => {
    const user = await trustUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeTrustStubJmap({ calls });

    const first = await readTrust(jmap, user);
    expect(first["backfilled-pass"]).toEqual({ trust: "known", from: "carla@backfilled.test" });
    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(1);

    // Second read: no backfill batches at all, only the thread's own.
    await readTrust(jmap, user);
    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(1);
    expect(calls.filter((c) => c[0]?.[0] === "Mailbox/get")).toHaveLength(1);
  });

  // GH #314 (JD-2): a failed backfill must not re-run inline on the very next
  // thread read. It runs on the route's critical path for a cosmetic feature,
  // so a persistently failing one used to cost every reader a Mailbox/get plus
  // a 200-message page on every thread they opened, indefinitely. The attempt
  // marker bounds it to one pass per retry window (see sent-recipients-backfill).
  it("still serves the thread when the backfill fails, and does NOT re-run it on the next read", async () => {
    const user = await trustUser();
    const calls: JmapMethodCall[][] = [];
    const failing = makeTrustStubJmap({ calls, backfillThrows: true });

    const trust = await readTrust(failing, user);
    expect(trust["known-pass"]?.trust).toBe("known");
    expect(trust["backfilled-pass"]?.trust).toBe("none");
    expect(calls.filter((c) => c[0]?.[0] === "Mailbox/get")).toHaveLength(1);

    // Second read, well inside the retry window: the thread is served exactly
    // the same way, with no backfill batch at all.
    const working = makeTrustStubJmap({ calls });
    const after = await readTrust(working, user);
    expect(after["known-pass"]?.trust).toBe("known");
    expect(after["backfilled-pass"]?.trust).toBe("none");
    expect(calls.filter((c) => c[0]?.[0] === "Mailbox/get")).toHaveLength(1);
    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(0);
  });

  it("does not run the backfill, and asserts no Tier A, when no sent-recipients store is wired", async () => {
    const user = await trustUser();
    const calls: JmapMethodCall[][] = [];
    const res = await makeApp(makeTrustStubJmap({ calls }), "mail.cefiro.test").request("/api/mail/threads/t5", {
      headers: { cookie: `session=${user.token}` },
    });
    const body = threadDetailSchema.parse(await res.json());
    expect(body.emails.find((e) => e.id === "known-pass")?.senderTrust).toBe("none");
    // Tier B still works without the store.
    expect(body.emails.find((e) => e.id === "seed-pass")?.senderTrust).toBe("trusted-service");
    expect(calls.filter((c) => c[0]?.[0] === "Mailbox/get")).toHaveLength(0);
  });
});
