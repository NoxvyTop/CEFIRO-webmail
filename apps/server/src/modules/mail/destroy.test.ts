import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import type { JmapClient, JmapMethodCall, JmapMethodResponse } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

const defaultMailboxList = [
  { id: "mb-inbox", role: "inbox" },
  { id: "mb-trash", role: "trash" },
];

type StubEmail = { id: string; mailboxIds?: Record<string, boolean> };

let requests: JmapMethodCall[][] = [];
let mailboxes: Array<{ id: string; role?: string | null }> = defaultMailboxList;
// What Email/get reports for the requested id — [] mirrors both "no such
// message" and "a message that belongs to a different account" (Email/get is
// scoped to accountId, so another account's message never shows up here).
let emailLookupList: StubEmail[] = [{ id: "e1", mailboxIds: { "mb-trash": true } }];
// Response to the Email/set carrying `destroy`.
let destroyResponse: Record<string, unknown> = { destroyed: ["e1"] };

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
    return methodCalls.map(([name, , callId]): JmapMethodResponse => {
      if (name === "Mailbox/get") return ["Mailbox/get", { list: mailboxes }, callId];
      if (name === "Email/get") return ["Email/get", { list: emailLookupList }, callId];
      if (name === "Email/set") return ["Email/set", destroyResponse, callId];
      throw new Error(`unexpected JMAP method call in test stub: ${name}`);
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
  mailboxes = defaultMailboxList;
  emailLookupList = [{ id: "e1", mailboxIds: { "mb-trash": true } }];
  destroyResponse = { destroyed: ["e1"] };
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

function destroy(id: string) {
  return makeApp().request(`/api/mail/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { cookie: `session=${token}` },
  });
}

function allCalls(): JmapMethodCall[] {
  return requests.flat();
}

function callsNamed(name: string): JmapMethodCall[] {
  return allCalls().filter(([callName]) => callName === name);
}

describe("DELETE /api/mail/messages/:id", () => {
  it("destroys a message that is actually in the account's Trash mailbox", async () => {
    const res = await destroy("e1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const destroyCall = callsNamed("Email/set").find(([, params]) => "destroy" in params);
    expect(destroyCall).toBeDefined();
    const params = destroyCall?.[1] as { accountId: string; destroy: string[] };
    expect(params.accountId).toBe("acc-1");
    expect(params.destroy).toEqual(["e1"]);
  });

  it("looks up the message's mailboxes before ever issuing a destroy", async () => {
    await destroy("e1");

    const destroyIndex = requests.findIndex((call) =>
      call.some(([name, params]) => name === "Email/set" && "destroy" in params),
    );
    const lookupIndex = requests.findIndex((call) => call.some(([name]) => name === "Email/get"));
    expect(lookupIndex).toBeGreaterThanOrEqual(0);
    expect(destroyIndex).toBeGreaterThan(lookupIndex);
  });

  // The client only offers "Delete permanently" while viewing Trash, but that
  // is not a security boundary — an id can arrive here from anywhere. This is
  // the server-side enforcement: a message sitting in the Inbox must never be
  // destroyable through this route, no matter what the client claims.
  it("refuses to destroy a message that is not in Trash, and issues no Email/set destroy", async () => {
    emailLookupList = [{ id: "e1", mailboxIds: { "mb-inbox": true } }];

    const res = await destroy("e1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("not_in_trash");
    expect(callsNamed("Email/set")).toHaveLength(0);
  });

  it("refuses to destroy a message that sits in Trash alongside another mailbox membership check failing (no trash role on the account)", async () => {
    mailboxes = [{ id: "mb-inbox", role: "inbox" }];

    const res = await destroy("e1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("not_in_trash");
    expect(callsNamed("Email/set")).toHaveLength(0);
  });

  // Email/get is scoped to this session's own accountId, so an id belonging
  // to a different account (or one that simply doesn't exist) is reported
  // back as an empty list — never leaked from another account. This route
  // must treat that exactly like "not in Trash" and refuse.
  it("refuses to destroy an id that does not resolve to a message in this account", async () => {
    emailLookupList = [];

    const res = await destroy("e1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("not_in_trash");
    expect(callsNamed("Email/set")).toHaveLength(0);
  });

  it("returns 409 destroy_failed when the JMAP response reports notDestroyed", async () => {
    destroyResponse = { notDestroyed: { e1: { type: "notFound" } } };

    const res = await destroy("e1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("destroy_failed");
  });

  // Absence from notDestroyed is not confirmation that anything was actually
  // destroyed — the same positive-confirmation rigor PATCH /messages/:id
  // already applies to `updated`/`notUpdated` above in this module.
  it("reports destroy_failed rather than success when the response names the id in neither destroyed nor notDestroyed", async () => {
    destroyResponse = {};

    const res = await destroy("e1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("destroy_failed");
  });

  it("returns 409 destroy_failed when the response names a different id as destroyed", async () => {
    destroyResponse = { destroyed: ["e-other"] };

    const res = await destroy("e1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("destroy_failed");
  });
});
