import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import {
  createSharedMailboxCopiesRepo,
  type SharedMailboxCopiesRepo,
} from "../../infra/repos/shared-mailbox-copies";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import { evictMailSession } from "./context";
import type { JmapClient, JmapMethodCall, JmapMethodResponse } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

// GH #13/#50 (G-2): a session that reaches the member's own account plus one
// shared (group) mailbox Stalwart exposes via membership. copy-to-inbox copies
// FROM the shared account TO the personal one with the member's own credential.
let requests: JmapMethodCall[][] = [];
// What Mailbox/query (personal account, role=inbox) reports.
let inboxQueryIds: string[] = ["mb-inbox-personal"];
// What Email/get (shared account) reports for the source id — [] mirrors both
// "no such message" and a message that belongs to another account.
let sourceEmailList: Array<{ id: string; keywords?: Record<string, boolean> }> = [
  { id: "e1", keywords: { $seen: true, $flagged: true } },
];
// Response to the Email/copy.
let copyResponse: Record<string, unknown> = { created: { c: { id: "copy-1" } } };

const stubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-personal",
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    accounts: [
      { id: "acc-personal", name: "Me", isPersonal: true },
      { id: "acc-shared", name: "Ventas", isPersonal: false },
    ],
  }),
  request: async (_auth, _session, methodCalls) => {
    requests.push(methodCalls);
    return methodCalls.map(([name, , callId]): JmapMethodResponse => {
      if (name === "Mailbox/query") return ["Mailbox/query", { ids: inboxQueryIds }, callId];
      if (name === "Email/get") return ["Email/get", { list: sourceEmailList }, callId];
      if (name === "Email/copy") return ["Email/copy", copyResponse, callId];
      throw new Error(`unexpected JMAP method call in test stub: ${name}`);
    });
  },
  uploadBlob: async () => "blob-id",
};

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let token: string;
let userId: string;

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
  userId = withCred.id;
  token = (await sessions.create(withCred.id, 1)).token;
});
afterAll(() => {
  // The JMAP session is cached per user (context.ts) — drop it so a later test
  // file's fresh stub is not shadowed by this one's accounts.
  evictMailSession(userId);
  return sql.end();
});

beforeEach(() => {
  requests = [];
  inboxQueryIds = ["mb-inbox-personal"];
  sourceEmailList = [{ id: "e1", keywords: { $seen: true, $flagged: true } }];
  copyResponse = { created: { c: { id: "copy-1" } } };
});

function makeApp(overrides: { sharedMailboxCopies?: SharedMailboxCopiesRepo } = {}) {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap: stubJmap,
      ...overrides,
    }),
  });
}

function copyToInbox(
  id: string,
  accountId?: string,
  overrides: { sharedMailboxCopies?: SharedMailboxCopiesRepo } = {},
) {
  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
  return makeApp(overrides).request(
    `/api/mail/messages/${encodeURIComponent(id)}/copy-to-inbox${query}`,
    {
      method: "POST",
      headers: { cookie: `session=${token}` },
    },
  );
}

function allCalls(): JmapMethodCall[] {
  return requests.flat();
}

function copyCall(): JmapMethodCall | undefined {
  return allCalls().find(([name]) => name === "Email/copy");
}

describe("POST /api/mail/messages/:id/copy-to-inbox", () => {
  it("requires a session", async () => {
    const res = await makeApp().request("/api/mail/messages/e1/copy-to-inbox?accountId=acc-shared", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("copies a shared-account message into the personal inbox with the right Email/copy shape", async () => {
    const res = await copyToInbox("e1", "acc-shared");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const call = copyCall();
    expect(call).toBeDefined();
    const params = call?.[1] as {
      fromAccountId: string;
      accountId: string;
      onSuccessDestroyOriginal: boolean;
      create: { c: { id: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> } };
    };
    // From the shared account, to the personal one — and the original stays put.
    expect(params.fromAccountId).toBe("acc-shared");
    expect(params.accountId).toBe("acc-personal");
    expect(params.onSuccessDestroyOriginal).toBe(false);
    // The copy targets the member's PERSONAL inbox, referencing the source id.
    expect(params.create.c.id).toBe("e1");
    expect(params.create.c.mailboxIds).toEqual({ "mb-inbox-personal": true });
    // The source email's keywords are carried over so flags survive.
    expect(params.create.c.keywords).toEqual({ $seen: true, $flagged: true });
  });

  it("resolves the personal inbox and the source keywords before issuing the copy", async () => {
    await copyToInbox("e1", "acc-shared");

    const copyIndex = requests.findIndex((call) => call.some(([name]) => name === "Email/copy"));
    const lookupIndex = requests.findIndex((call) =>
      call.some(([name]) => name === "Mailbox/query"),
    );
    expect(lookupIndex).toBeGreaterThanOrEqual(0);
    expect(copyIndex).toBeGreaterThan(lookupIndex);

    // The inbox lookup runs against the PERSONAL account; the keyword fetch
    // against the SHARED account where the message lives.
    const lookup = requests[lookupIndex]!;
    const mailboxQuery = lookup.find(([name]) => name === "Mailbox/query");
    expect((mailboxQuery?.[1] as { accountId: string }).accountId).toBe("acc-personal");
    expect((mailboxQuery?.[1] as { filter: { role: string } }).filter.role).toBe("inbox");
    const emailGet = lookup.find(([name]) => name === "Email/get");
    expect((emailGet?.[1] as { accountId: string }).accountId).toBe("acc-shared");
  });

  it("carries an empty keyword set when the source email has none", async () => {
    sourceEmailList = [{ id: "e1" }];

    const res = await copyToInbox("e1", "acc-shared");
    expect(res.status).toBe(200);
    const params = copyCall()?.[1] as { create: { c: { keywords: Record<string, boolean> } } };
    expect(params.create.c.keywords).toEqual({});
  });

  it("rejects a personal/own accountId with 400 invalid_account and issues no copy", async () => {
    const res = await copyToInbox("e1", "acc-personal");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_account");
    expect(copyCall()).toBeUndefined();
  });

  it("rejects an absent accountId (defaults to personal) with 400 invalid_account and issues no copy", async () => {
    const res = await copyToInbox("e1");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_account");
    expect(copyCall()).toBeUndefined();
  });

  it("rejects an accountId the session cannot reach with 403 account_forbidden and issues no copy", async () => {
    const res = await copyToInbox("e1", "acc-other");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("account_forbidden");
    expect(copyCall()).toBeUndefined();
  });

  it("returns 502 mailbox_roles_missing when the personal inbox cannot be resolved", async () => {
    inboxQueryIds = [];

    const res = await copyToInbox("e1", "acc-shared");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("mailbox_roles_missing");
    expect(copyCall()).toBeUndefined();
  });

  it("returns 404 not_found when the source message is not in the shared account", async () => {
    sourceEmailList = [];

    const res = await copyToInbox("e1", "acc-shared");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
    expect(copyCall()).toBeUndefined();
  });

  it("returns 502 copy_failed when the JMAP response reports notCreated", async () => {
    copyResponse = { notCreated: { c: { type: "invalidArguments" } } };

    const res = await copyToInbox("e1", "acc-shared");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("copy_failed");
  });

  it("reports copy_failed rather than success when the response confirms neither created nor notCreated", async () => {
    copyResponse = {};

    const res = await copyToInbox("e1", "acc-shared");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("copy_failed");
  });

  // GH #313: the automatic delivery cycle and this button copy the same
  // messages into the same inbox, and only the ledger keeps them from doing it
  // twice. A manual copy that wrote nothing was invisible to the cycle, which
  // then delivered its own copy of a message the member already had.
  describe("shared-mailbox copy ledger (GH #313)", () => {
    it("records the manual copy so the automatic cycle does not repeat it", async () => {
      const copies = createSharedMailboxCopiesRepo(sql);
      const res = await copyToInbox("e1", "acc-shared", { sharedMailboxCopies: copies });

      expect(res.status).toBe(200);
      expect(await copies.hasCopy(userId, "acc-shared", "e1")).toBe(true);
      // Recorded against the SHARED account the message came from, not the
      // personal one it landed in — that is the key the cycle looks up.
      expect(await copies.hasCopy(userId, "acc-personal", "e1")).toBe(false);
    });

    it("records nothing when the copy itself failed", async () => {
      const copies = createSharedMailboxCopiesRepo(sql);
      copyResponse = { notCreated: { c: { type: "overQuota" } } };

      const res = await copyToInbox("e2", "acc-shared", { sharedMailboxCopies: copies });
      expect(res.status).toBe(502);
      expect(await copies.hasCopy(userId, "acc-shared", "e2")).toBe(false);
    });

    it("still answers ok when the copy was made but the ledger write failed", async () => {
      const copies = createSharedMailboxCopiesRepo(sql);
      const failing: SharedMailboxCopiesRepo = {
        ...copies,
        recordCopy: () => Promise.reject(new Error("database unavailable")),
      };

      // The message IS in the member's inbox; answering 502 would invite them
      // to press the button again and get a second copy.
      const res = await copyToInbox("e3", "acc-shared", { sharedMailboxCopies: failing });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("copies exactly as before for a deployment that wires no ledger", async () => {
      const res = await copyToInbox("e4", "acc-shared");
      expect(res.status).toBe(200);
      expect(copyCall()).toBeDefined();
    });
  });
});
