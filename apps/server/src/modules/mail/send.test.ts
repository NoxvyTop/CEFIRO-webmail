import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
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

const sql = createDb(testDatabaseUrl());

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
// RFC 8621 §7.5: onSuccessUpdateEmail is applied by a SEPARATE implicit
// Email/set that runs after the submission and is appended to the response
// array with the same method-call id ("s") as EmailSubmission/set. RFC 8620
// §5.3 makes that Email/set non-transactional, so the submission can succeed
// while this update fails — which is exactly the partial failure under test.
let implicitUpdateResponse: { updated?: Record<string, unknown>; notUpdated?: Record<string, unknown> } = {
  updated: { "e-new": null },
};
// Response to the server's best-effort post-send remediation (a lone
// Email/set update re-applying the move-to-Sent / $draft-clear patch).
let remediationResponse: { updated?: Record<string, unknown>; notUpdated?: Record<string, unknown> } = {
  updated: { "e-new": null },
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
    // The best-effort post-send remediation is a single Email/set update.
    if (methodCalls.length === 1 && name === "Email/set") {
      return [["Email/set", remediationResponse, "u"]];
    }
    // The /send request: draft create + submission + the implicit
    // onSuccessUpdateEmail response (same "s" id, appended by the server).
    return [
      ["Email/set", emailSetResponse, "e"],
      ["EmailSubmission/set", submissionResponse, "s"],
      ["Email/set", implicitUpdateResponse, "s"],
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

beforeEach(() => {
  requests = [];
  identityList = defaultIdentityList;
  mailboxes = defaultMailboxList;
  emailSetResponse = { created: { draft: { id: "e-new" } } };
  submissionResponse = { created: { sub: { id: "sub-1" } } };
  implicitUpdateResponse = { updated: { "e-new": null } };
  remediationResponse = { updated: { "e-new": null } };
});

function makeApp() {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap: stubJmap,
    }),
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
  // RFC 8621: JMAP exposes and accepts message ids in parsed form — no
  // surrounding angle brackets and no CFWS.
  inReplyTo: ["msg-1@noxvytop.com"],
  references: ["msg-0@noxvytop.com", "msg-1@noxvytop.com"],
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
      inReplyTo: ["msg-1@noxvytop.com"],
      references: ["msg-0@noxvytop.com", "msg-1@noxvytop.com"],
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

  // GH #120: [] is truthy in JavaScript, so a plain truthiness guard would
  // forward an empty inReplyTo/references array to Email/set instead of
  // omitting the property. A non-reply payload must produce neither key.
  it("omits inReplyTo and references from the Email/set create object for a non-reply payload", async () => {
    const { inReplyTo: _inReplyTo, references: _references, ...nonReply } = basePayload;
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(nonReply),
    });
    expect(res.status).toBe(200);

    const create = (requests[1]?.[0]?.[1] as { create: Record<string, Record<string, unknown>> })
      .create.draft as Record<string, unknown>;
    expect(create).not.toHaveProperty("inReplyTo");
    expect(create).not.toHaveProperty("references");
  });

  it("omits inReplyTo and references when the payload carries empty arrays", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...basePayload, inReplyTo: [], references: [] }),
    });
    expect(res.status).toBe(200);

    const create = (requests[1]?.[0]?.[1] as { create: Record<string, Record<string, unknown>> })
      .create.draft as Record<string, unknown>;
    expect(create).not.toHaveProperty("inReplyTo");
    expect(create).not.toHaveProperty("references");
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

  // GH #192: positive confirmation of the send, mirroring the draft-save (#149)
  // and destroy (#133) paths. Three outcomes to pin down:
  //   1. submission confirmed in `created` + post-send update confirmed -> ok,
  //      no remediation.
  //   2. submission absent from `created` -> the mail did NOT go out, so we
  //      must fail, never falsely report success off an empty notCreated.
  //   3. submission confirmed but the post-send move-to-Sent failed -> the mail
  //      IS out, so still report sent (no resend prompt), but re-clear the
  //      $draft state so the sent message is not re-presented as a fresh draft.
  it("confirms the submission and the post-send email update, issuing no remediation", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(basePayload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Lookup + send only: the implicit onSuccessUpdateEmail confirmed, so there
    // is nothing left to remediate.
    expect(requests).toHaveLength(2);
  });

  it("returns 502 send_failed and does not falsely report success when the submission is absent from created", async () => {
    // Neither `created` nor `notCreated` names the submission: the server never
    // confirmed it, so the mail did NOT go out. A truthiness-only guard on
    // notCreated would fall through to { ok: true } — a phantom success that
    // hides a non-delivery.
    submissionResponse = {};

    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("send_failed");
    // Nothing was sent, so no post-send remediation must be attempted.
    expect(requests).toHaveLength(2);
  });

  it("still reports the message as sent but re-clears $draft when the post-send email update fails", async () => {
    // Submission created (mail is out) but the implicit onSuccessUpdateEmail
    // could not move the message to Sent / clear $draft.
    implicitUpdateResponse = { notUpdated: { "e-new": { type: "stateMismatch" } } };

    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    // The mail went out — erroring here would invite a duplicate resend.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // A best-effort remediation Email/set re-applies the move-to-Sent /
    // $draft-clear patch so the already-sent message does not linger as a
    // fresh, re-sendable draft.
    expect(requests).toHaveLength(3);
    const remediation = requests[2] ?? [];
    expect(remediation).toHaveLength(1);
    const remediationCall = remediation[0];
    expect(remediationCall?.[0]).toBe("Email/set");
    const remediationParams = remediationCall?.[1] as {
      accountId: string;
      update: Record<string, Record<string, unknown>>;
    };
    expect(remediationParams.accountId).toBe("acc-1");
    expect(remediationParams.update["e-new"]).toEqual({
      "mailboxIds/mb-drafts": null,
      "mailboxIds/mb-sent": true,
      "keywords/$draft": null,
    });
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
