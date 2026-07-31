import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
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
import { identitySchema } from "@webmail/shared";
import type { JmapClient } from "../../infra/stalwart/jmap";

const sql = createDb(testDatabaseUrl());

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
      "Identity/get",
      {
        list: [
          { id: "id-1", name: "Primary Identity", email: "user@example.com" },
          { id: "id-2", name: null, email: "alt@example.com" },
          { id: "id-3", name: "No Email Identity" },
        ],
      },
      "0",
    ],
  ],
  uploadBlob: async () => "blob-id",
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

describe("GET /api/mail/identities", () => {
  it("requires a session", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/identities");
    expect(res.status).toBe(401);
  });

  it("returns 503 when stalwart is not configured", async () => {
    const res = await makeApp(null).request("/api/mail/identities", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("mail_not_configured");
  });

  it("returns 503 when the user has no mail credential", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/identities", {
      headers: { cookie: `session=${tokenNoCred}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("mail_credentials_missing");
  });

  it("returns identities with mapped names and filtered by email", async () => {
    const res = await makeApp(stubJmap).request("/api/mail/identities", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const parsed = z.array(identitySchema).safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toHaveLength(2);
      expect(parsed.data[0]).toEqual({
        id: "id-1",
        name: "Primary Identity",
        email: "user@example.com",
      });
      expect(parsed.data[1]).toEqual({
        id: "id-2",
        name: "",
        email: "alt@example.com",
      });
    }
  });
});
