import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("returns only the non-personal accounts from the cached session", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/shared-accounts", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string }>;
    expect(body).toEqual([{ id: "acc-shared", name: "Ventas" }]);
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
