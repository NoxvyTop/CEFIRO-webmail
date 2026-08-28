import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createMailRouter } from "./router";
import { evictMailSession } from "./context";
import type { JmapClient, JmapMethodCall } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

// GH #13/#50: a session that lists the member's own account plus one shared
// (group) mailbox Stalwart exposes via membership — the whole point of this
// slice. `request` records the accountId each JMAP call ran against so the
// resolveAccountId wiring can be asserted end-to-end through the router.
let lastCalls: JmapMethodCall[] = [];

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
  request: async (_auth, _session, calls) => {
    lastCalls = calls;
    return [["Mailbox/get", { list: [] }, "0"]];
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

// The copy opt-in lives in user_preferences (G-3), which persists across tests
// in this file; clear the row so each test starts from the default (opted out).
afterEach(async () => {
  await sql`delete from user_preferences where user_id = ${userId}`;
});

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

describe("GET /api/mail/shared-accounts", () => {
  it("requires a session", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/shared-accounts");
    expect(res.status).toBe(401);
  });

  it("returns only the non-personal accounts from the cached session, opted out by default", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/shared-accounts", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string; copyOptIn: boolean }>;
    expect(body).toEqual([{ id: "acc-shared", name: "Ventas", copyOptIn: false }]);
  });

  it("reflects copyOptIn=true after the member opts that shared account in (G-3)", async () => {
    const app = makeApp(stubJmap);
    const put = await app.request("/api/mail/shared-accounts/acc-shared/copy-preference", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ copyOptIn: true }),
    });
    expect(put.status).toBe(200);

    const res = await app.request("/api/mail/shared-accounts", {
      headers: { cookie: `session=${token}` },
    });
    const body = (await res.json()) as Array<{ id: string; copyOptIn: boolean }>;
    expect(body).toEqual([{ id: "acc-shared", name: "Ventas", copyOptIn: true }]);
  });
});

describe("PUT /api/mail/shared-accounts/:id/copy-preference (G-3)", () => {
  function setCopyPreference(id: string, copyOptIn: unknown, withSession = true) {
    return makeApp(stubJmap).request(`/api/mail/shared-accounts/${id}/copy-preference`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(withSession ? { cookie: `session=${token}` } : {}),
      },
      body: JSON.stringify({ copyOptIn }),
    });
  }

  it("requires a session", async () => {
    const res = await setCopyPreference("acc-shared", true, false);
    expect(res.status).toBe(401);
  });

  it("opts a shared account in and returns the updated state", async () => {
    const res = await setCopyPreference("acc-shared", true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "acc-shared", name: "Ventas", copyOptIn: true });
  });

  it("opts a shared account back out and returns the updated state", async () => {
    await setCopyPreference("acc-shared", true);
    const res = await setCopyPreference("acc-shared", false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "acc-shared", name: "Ventas", copyOptIn: false });
  });

  it("persists the opt-in across requests", async () => {
    await setCopyPreference("acc-shared", true);
    const prefs = await createUserPreferencesRepo(sql).get(userId);
    expect(prefs.sharedMailboxCopyOptIn).toEqual(["acc-shared"]);
  });

  it("rejects a personal/own accountId with 400 invalid_account", async () => {
    const res = await setCopyPreference("acc-personal", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_account");
  });

  it("rejects an accountId the session cannot reach with 403 account_forbidden", async () => {
    const res = await setCopyPreference("acc-other", true);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("account_forbidden");
  });

  it("rejects a body without a boolean copyOptIn with 400 invalid_body", async () => {
    const res = await setCopyPreference("acc-shared", "yes");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });
});

describe("shared-mailbox access via ?accountId= (resolveAccountId)", () => {
  it("runs a mail request against a shared account the session can reach", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/mailboxes?accountId=acc-shared", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(lastCalls[0]?.[1].accountId).toBe("acc-shared");
  });

  it("defaults to the personal account when no accountId is passed", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/mailboxes", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(lastCalls[0]?.[1].accountId).toBe("acc-personal");
  });

  it("rejects an accountId the session cannot reach with 403 account_forbidden", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/mailboxes?accountId=acc-other", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("account_forbidden");
  });
});
