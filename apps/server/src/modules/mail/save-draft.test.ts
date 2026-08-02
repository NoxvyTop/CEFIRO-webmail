import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { JmapClient, JmapMethodCall, JmapMethodResponse } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

const defaultIdentityList = [{ id: "id-1", name: "Carlos", email: "carlos@noxvytop.com" }];
const defaultMailboxList = [
  { id: "mb-inbox", role: "inbox" },
  { id: "mb-drafts", role: "drafts" },
  { id: "mb-sent", role: "sent" },
  { id: "mb-trash", role: "trash" },
];

type StubEmail = {
  id: string;
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
};

// A genuine draft: $draft keyword AND sitting in the Drafts mailbox. This is
// the only shape the route is allowed to move to Trash.
const originalDraft: StubEmail = {
  id: "e-old",
  mailboxIds: { "mb-drafts": true },
  keywords: { $draft: true, $seen: true },
};

let requests: JmapMethodCall[][] = [];
let identityList: Array<{ id: string; name?: string | null; email: string }> = defaultIdentityList;
let mailboxes: Array<{ id: string; role?: string | null }> = defaultMailboxList;
// Response to the Email/set that carries `create` — i.e. the new draft.
let createResponse: Record<string, unknown> = { created: { draft: { id: "draft-new" } } };
// Response to the Email/set that carries `update` — i.e. the move to Trash.
let updateResponse: Record<string, unknown> = { updated: { "e-old": null } };
// What Email/get returns for the claimed originalDraftId.
let originalLookupList: StubEmail[] = [originalDraft];

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
    if (methodCalls[0]?.[0] === "Identity/get") {
      return [
        ["Identity/get", { list: identityList }, "i"],
        ["Mailbox/get", { list: mailboxes }, "m"],
      ];
    }
    // Answer each call on its own so the route can batch or split however it
    // likes without the stub dictating the shape.
    return methodCalls.map(([name, params, callId]): JmapMethodResponse => {
      if (name === "Email/get") return ["Email/get", { list: originalLookupList }, callId];
      if ("create" in params) return ["Email/set", createResponse, callId];
      return ["Email/set", updateResponse, callId];
    });
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
  createResponse = { created: { draft: { id: "draft-new" } } };
  updateResponse = { updated: { "e-old": null } };
  originalLookupList = [originalDraft];
});

afterEach(() => {
  vi.restoreAllMocks();
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

function post(body: unknown) {
  return makeApp().request("/api/mail/drafts", {
    method: "POST",
    headers: { cookie: `session=${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- Observable outcomes, read off the JMAP calls the route actually made ---

function allCalls(): JmapMethodCall[] {
  return requests.flat();
}

function callsNamed(name: string): JmapMethodCall[] {
  return allCalls().filter(([callName]) => callName === name);
}

function createCall(): JmapMethodCall | undefined {
  return callsNamed("Email/set").find(([, params]) => "create" in params);
}

function updateCalls(): JmapMethodCall[] {
  return callsNamed("Email/set").filter(([, params]) => "update" in params);
}

/** Ids the route asked the server to mutate via Email/set `update`. */
function mutatedIds(): string[] {
  return updateCalls().flatMap(([, params]) =>
    Object.keys((params as { update: Record<string, unknown> }).update),
  );
}

/** The patch applied to `id`, across every Email/set update the route issued. */
function patchFor(id: string): Record<string, unknown> | undefined {
  for (const [, params] of updateCalls()) {
    const update = (params as { update: Record<string, Record<string, unknown>> }).update;
    const patch = update[id];
    if (patch) return patch;
  }
  return undefined;
}

/** Index into `requests` of the request carrying the Email/set that creates. */
function createRequestIndex(): number {
  return requests.findIndex((call) =>
    call.some(([name, params]) => name === "Email/set" && "create" in params),
  );
}

/** Index into `requests` of the request carrying the Email/set that updates. */
function updateRequestIndex(): number {
  return requests.findIndex((call) =>
    call.some(([name, params]) => name === "Email/set" && "update" in params),
  );
}

function warnLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.flatMap((args) => {
    try {
      return [JSON.parse(String(args[0])) as Record<string, unknown>];
    } catch {
      return [];
    }
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
  inReplyTo: ["msg-1@noxvytop.com"],
  references: ["msg-0@noxvytop.com", "msg-1@noxvytop.com"],
};

describe("POST /api/mail/drafts", () => {
  it("creates the draft in the Drafts mailbox with $draft/$seen keywords and returns its id", async () => {
    const res = await post(basePayload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "draft-new" });

    const lookupCall = requests[0] ?? [];
    expect(lookupCall[0]?.[0]).toBe("Identity/get");
    expect(lookupCall[1]?.[0]).toBe("Mailbox/get");

    const created = createCall();
    expect(created).toBeDefined();
    const emailSetParams = created?.[1] as { accountId: string; create: Record<string, unknown> };
    expect(emailSetParams.accountId).toBe("acc-1");
    expect(emailSetParams.create.draft).toEqual({
      from: [{ name: "Carlos", email: "carlos@noxvytop.com" }],
      to: [{ name: "Bob", email: "bob@noxvytop.com" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      keywords: { $draft: true, $seen: true },
      mailboxIds: { "mb-drafts": true },
      bodyValues: { t: { value: "Plain text" }, h: { value: "<p>Rich text</p>" } },
      textBody: [{ partId: "t", type: "text/plain" }],
      htmlBody: [{ partId: "h", type: "text/html" }],
      attachments: [{ blobId: "blob-1", type: "application/pdf", name: "file.pdf", disposition: "attachment" }],
      inReplyTo: ["msg-1@noxvytop.com"],
      references: ["msg-0@noxvytop.com", "msg-1@noxvytop.com"],
    });
  });

  it("saves a draft with no recipients and no subject", async () => {
    const res = await post({ identityId: "id-1", textBody: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "draft-new" });

    const create = (createCall()?.[1] as { create: { draft: Record<string, unknown> } }).create.draft;
    expect(create.to).toEqual([]);
    expect(create.cc).toEqual([]);
    expect(create.bcc).toEqual([]);
    expect(create.subject).toBe("");
  });

  // A saved draft is never submitted — this is the whole difference from
  // /send, and it must hold on every path through the route.
  it("never issues an EmailSubmission on any path", async () => {
    await post(basePayload);
    expect(callsNamed("EmailSubmission/set")).toHaveLength(0);

    requests = [];
    await post({ ...basePayload, originalDraftId: "e-old" });
    expect(callsNamed("EmailSubmission/set")).toHaveLength(0);

    requests = [];
    createResponse = { notCreated: { draft: { type: "overQuota" } } };
    await post({ ...basePayload, originalDraftId: "e-old" });
    expect(callsNamed("EmailSubmission/set")).toHaveLength(0);
  });

  it("issues no Email/set update at all when there is no originalDraftId", async () => {
    const res = await post(basePayload);
    expect(res.status).toBe(200);
    expect(updateCalls()).toHaveLength(0);
  });

  describe("replacing a superseded original draft", () => {
    it("moves the original out of Drafts and into Trash once the new draft exists", async () => {
      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "draft-new" });

      expect(mutatedIds()).toEqual(["e-old"]);
      expect(patchFor("e-old")).toEqual({
        "mailboxIds/mb-drafts": null,
        "mailboxIds/mb-trash": true,
      });
    });

    // RFC 8620 §5.3: Email/set is not transactional across create and update
    // without ifInState. Carrying both in one call lets the server trash the
    // original while failing to create its replacement.
    it("never carries the create and the move-to-Trash in the same Email/set", async () => {
      await post({ ...basePayload, originalDraftId: "e-old" });

      for (const [name, params] of callsNamed("Email/set")) {
        expect(name).toBe("Email/set");
        expect("create" in params && "update" in params).toBe(false);
      }
    });

    it("issues the move-to-Trash strictly after the request that created the draft", async () => {
      await post({ ...basePayload, originalDraftId: "e-old" });

      const createIndex = createRequestIndex();
      const updateIndex = updateRequestIndex();
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(updateIndex).toBeGreaterThan(createIndex);
    });

    // THE data-loss regression: if the original were trashed alongside a
    // create that failed, the user's work would be gone with only a 502 to
    // show for it.
    it("does not move the original to Trash when the draft could not be created", async () => {
      createResponse = { notCreated: { draft: { type: "overQuota" } } };

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code: string }).code).toBe("save_draft_failed");

      expect(mutatedIds()).toEqual([]);
      expect(updateCalls()).toHaveLength(0);
    });

    it("does not move the original to Trash when the create response names no created id", async () => {
      createResponse = { created: { draft: {} } };

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code: string }).code).toBe("save_draft_failed");
      expect(updateCalls()).toHaveLength(0);
    });

    // The move is cleanup, not the point of the request: the user's work is
    // already stored by then, so a failed cleanup leaves a visible duplicate
    // rather than failing the save.
    it("reports success and returns the new id when the move to Trash is rejected", async () => {
      updateResponse = { notUpdated: { "e-old": { type: "notFound" } } };

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "draft-new" });
    });

    it("reports success when the move to Trash throws", async () => {
      const failing: JmapClient = {
        ...stubJmap,
        request: async (auth, session, methodCalls) => {
          if (methodCalls.some(([name, params]) => name === "Email/set" && "update" in params)) {
            throw new Error("upstream exploded");
          }
          return stubJmap.request(auth, session, methodCalls);
        },
      };
      const app = createApp({
        mailRouter: createMailRouter({
          sessions,
          mailCredentials,
          signatures: createSignaturesRepo(sql),
          userPreferences: createUserPreferencesRepo(sql),
          jmap: failing,
        }),
      });

      const res = await app.request("/api/mail/drafts", {
        method: "POST",
        headers: { cookie: `session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...basePayload, originalDraftId: "e-old" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "draft-new" });
    });

    // Absence from notUpdated is not confirmation that anything moved — the
    // same positive check PATCH /messages/:id already makes.
    it("treats a response naming the id in neither updated nor notUpdated as a failed move", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      updateResponse = {};

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "draft-new" });

      // Not a silent success: the unconfirmed move is reported.
      expect(warnLines(warn).some((line) => line.originalDraftId === "e-old")).toBe(true);
    });

    it("treats a response naming a different id in updated as a failed move", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      updateResponse = { updated: { "e-other": null } };

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(warnLines(warn).some((line) => line.originalDraftId === "e-old")).toBe(true);
    });

    it("does not warn when the move is positively confirmed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(warnLines(warn)).toEqual([]);
    });
  });

  // ?compose=draft:<id> routes ANY message in the thread through
  // buildEditDraft (see MailPage.tsx), so originalDraftId can name an inbox
  // or sent message. Trashing it would destroy a real message.
  describe("originalDraftId validation", () => {
    it("does not move a message that is not in the Drafts mailbox, and still saves", async () => {
      originalLookupList = [
        { id: "e-old", mailboxIds: { "mb-inbox": true }, keywords: { $seen: true } },
      ];

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "draft-new" });
      expect(mutatedIds()).toEqual([]);
    });

    it("does not move a message in Drafts that lacks the $draft keyword, and still saves", async () => {
      originalLookupList = [
        { id: "e-old", mailboxIds: { "mb-drafts": true }, keywords: { $seen: true } },
      ];

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(mutatedIds()).toEqual([]);
    });

    it("does not move a $draft message that already left the Drafts mailbox", async () => {
      originalLookupList = [
        { id: "e-old", mailboxIds: { "mb-trash": true }, keywords: { $draft: true } },
      ];

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(mutatedIds()).toEqual([]);
    });

    it("does not move anything when the claimed original does not exist, and still saves", async () => {
      originalLookupList = [];

      const res = await post({ ...basePayload, originalDraftId: "e-unknown" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "draft-new" });
      expect(mutatedIds()).toEqual([]);
    });

    // "#" is JMAP's creation-id reference namespace and this very call creates
    // under the creation id "draft", so "#draft" could aim the cleanup at the
    // message just created.
    it("rejects a #-prefixed originalDraftId before any JMAP call is made", async () => {
      const res = await post({ ...basePayload, originalDraftId: "#draft" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
      expect(requests).toHaveLength(0);
    });
  });

  describe("mailbox roles", () => {
    it("returns 502 mailbox_roles_missing when the drafts mailbox role is absent", async () => {
      mailboxes = [{ id: "mb-inbox", role: "inbox" }];

      const res = await post(basePayload);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code: string }).code).toBe("mailbox_roles_missing");
    });

    // A missing Trash mailbox makes the cleanup impossible, not the save.
    // Refusing to store the user's work over an impossible tidy-up is the same
    // mistake as trashing the original before the replacement exists.
    it("still creates the draft when originalDraftId is set but no trash role exists", async () => {
      mailboxes = [{ id: "mb-drafts", role: "drafts" }];

      const res = await post({ ...basePayload, originalDraftId: "e-old" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "draft-new" });
      expect(createCall()).toBeDefined();
      expect(mutatedIds()).toEqual([]);
    });
  });

  describe("input errors", () => {
    it("returns 400 invalid_identity for an unknown identity and skips the draft request", async () => {
      identityList = [];

      const res = await post(basePayload);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_identity");
      expect(requests).toHaveLength(1);
    });

    it("returns 502 save_draft_failed when the Email/set create is rejected", async () => {
      createResponse = { notCreated: { draft: { type: "invalidProperties" } } };

      const res = await post(basePayload);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code: string }).code).toBe("save_draft_failed");
    });

    it("returns 400 invalid_body for malformed JSON", async () => {
      const res = await post("{");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
    });
  });
});
