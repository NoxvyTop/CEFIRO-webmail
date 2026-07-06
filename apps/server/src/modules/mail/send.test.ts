import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { JmapClient, JmapMethodCall } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

const defaultIdentityList = [{ id: "id-1", name: "Carlos", email: "carlos@noxvytop.com" }];
const defaultMailboxList = [
  { id: "mb-inbox", role: "inbox" },
  { id: "mb-drafts", role: "drafts" },
  { id: "mb-sent", role: "sent" },
];

let requests: JmapMethodCall[][] = [];
let identityList: Array<{ id: string; name?: string | null; email: string }> = defaultIdentityList;
let mailboxes: Array<{ id: string; role?: string | null }> = defaultMailboxList;
let emailSetResponse: { created?: Record<string, unknown>; notCreated?: Record<string, unknown> } = {
  created: { draft: { id: "e-new" } },
};
let submissionResponse: { created?: Record<string, unknown>; notCreated?: Record<string, unknown> } = {
  created: { sub: { id: "sub-1" } },
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
    requests.push(methodCalls);
    const name = methodCalls[0]?.[0];
    if (name === "Identity/get") {
      return [
        ["Identity/get", { list: identityList }, "i"],
        ["Mailbox/get", { list: mailboxes }, "m"],
      ];
    }
    return [
      ["Email/set", emailSetResponse, "e"],
      ["EmailSubmission/set", submissionResponse, "s"],
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

beforeEach(() => {
  requests = [];
  identityList = defaultIdentityList;
  mailboxes = defaultMailboxList;
  emailSetResponse = { created: { draft: { id: "e-new" } } };
  submissionResponse = { created: { sub: { id: "sub-1" } } };
});

function makeApp() {
  return createApp({
    mailRouter: createMailRouter({ sessions, mailCredentials, signatures: createSignaturesRepo(sql), jmap: stubJmap }),
  });
}

const basePayload = {
  identityId: "id-1",
  to: [{ name: "Bob", email: "bob@noxvytop.com" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  textBody: "Plain text",
  htmlBody: "<p>Rich text</p>",
  attachments: [{ blobId: "blob-1", name: "file.pdf", type: "application/pdf" }],
  inReplyTo: ["<msg-1@noxvytop.com>"],
  references: ["<msg-0@noxvytop.com>", "<msg-1@noxvytop.com>"],
};

describe("POST /api/mail/send", () => {
  it("builds the draft + submission JMAP calls and returns ok on success", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(basePayload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(requests).toHaveLength(2);
    const lookupCall = requests[0] ?? [];
    const sendCall = requests[1] ?? [];
    expect(lookupCall[0]?.[0]).toBe("Identity/get");
    expect(lookupCall[1]?.[0]).toBe("Mailbox/get");

    const emailSetCall = sendCall[0];
    expect(emailSetCall?.[0]).toBe("Email/set");
    const emailSetParams = emailSetCall?.[1] as { accountId: string; create: Record<string, unknown> };
    expect(emailSetParams.accountId).toBe("acc-1");
    expect(emailSetParams.create.draft).toEqual({
      from: [{ name: "Carlos", email: "carlos@noxvytop.com" }],
      to: [{ name: "Bob", email: "bob@noxvytop.com" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      keywords: { $seen: true },
      mailboxIds: { "mb-drafts": true },
      bodyValues: { t: { value: "Plain text" }, h: { value: "<p>Rich text</p>" } },
      textBody: [{ partId: "t", type: "text/plain" }],
      htmlBody: [{ partId: "h", type: "text/html" }],
      attachments: [{ blobId: "blob-1", type: "application/pdf", name: "file.pdf", disposition: "attachment" }],
      inReplyTo: ["<msg-1@noxvytop.com>"],
      references: ["<msg-0@noxvytop.com>", "<msg-1@noxvytop.com>"],
    });

    const submissionCall = sendCall[1];
    expect(submissionCall?.[0]).toBe("EmailSubmission/set");
    const submissionParams = submissionCall?.[1] as {
      accountId: string;
      create: Record<string, unknown>;
      onSuccessUpdateEmail: Record<string, unknown>;
    };
    expect(submissionParams.accountId).toBe("acc-1");
    expect(submissionParams.create).toEqual({ sub: { emailId: "#draft", identityId: "id-1" } });
    expect(submissionParams.onSuccessUpdateEmail).toEqual({
      "#sub": {
        "mailboxIds/mb-drafts": null,
        "mailboxIds/mb-sent": true,
        "keywords/$draft": null,
      },
    });
  });

  it("returns 400 invalid_identity for an unknown identity and skips the send request", async () => {
    identityList = [];
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(basePayload),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_identity");
    expect(requests).toHaveLength(1);
  });

  it("returns 502 mailbox_roles_missing when the sent mailbox role is absent", async () => {
    mailboxes = [
      { id: "mb-inbox", role: "inbox" },
      { id: "mb-drafts", role: "drafts" },
    ];
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(basePayload),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("mailbox_roles_missing");
  });

  it("returns 502 send_failed when the submission is not created", async () => {
    submissionResponse = { notCreated: { sub: { type: "invalidProperties" } } };
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(basePayload),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("send_failed");
  });

  it("returns 400 invalid_body for zero recipients", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ identityId: "id-1", textBody: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
    expect(requests).toHaveLength(0);
  });

  it("returns 400 invalid_body for malformed JSON", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });
});
