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
import type { JmapClient } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

const stubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
  }),
  request: async () => [
    [
      "Mailbox/get",
      {
        list: [
          { id: "mb2", name: "Sent", parentId: null, role: "sent", sortOrder: 2, unreadEmails: 0, totalEmails: 5 },
          { id: "mb1", name: "Inbox", role: "inbox", sortOrder: 1, unreadEmails: 3, totalEmails: 10 },
        ],
      },
      "0",
    ],
  ],
};

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let token: string;
let tokenNoCred: string;

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

  const withoutCred = await users.create({
    email: `nc-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "No Cred",
  });
  tokenNoCred = (await sessions.create(withoutCred.id, 1)).token;
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

describe("GET /api/mail/mailboxes", () => {
  it("requires a session", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/mailboxes");
    expect(res.status).toBe(401);
  });

  it("returns 503 when stalwart is not configured", async () => {
    const res = await makeApp(null).request("/api/mail/mailboxes", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("mail_not_configured");
  });

  it("returns 503 when the user has no mail credential", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/mailboxes", {
      headers: { cookie: `session=${tokenNoCred}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("mail_credentials_missing");
  });

  it("maps and sorts mailboxes", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/mailboxes", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; parentId: string | null }>;
    expect(body.map((m) => m.id)).toEqual(["mb1", "mb2"]);
    expect(body[0]?.parentId).toBeNull();
  });
});
