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

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let signatures: ReturnType<typeof createSignaturesRepo>;
let userPreferences: ReturnType<typeof createUserPreferencesRepo>;
let token: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  signatures = createSignaturesRepo(sql);
  userPreferences = createUserPreferencesRepo(sql);
  sessions = createSessionStore(sql);

  const user = await users.create({
    email: `prefs-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Preferences User",
  });
  token = (await sessions.create(user.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp() {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures,
      jmap: null,
      userPreferences,
    }),
  });
}

describe("preferences routes", () => {
  it("requires a session", async () => {
    const res = await makeApp().request("/api/mail/preferences");
    expect(res.status).toBe(401);
  });

  it("defaults groupMailInMainInbox to true before any set", async () => {
    const res = await makeApp().request("/api/mail/preferences", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groupMailInMainInbox: true });
  });

  it("persists a PUT and reflects it on a subsequent GET", async () => {
    const app = makeApp();

    const putRes = await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ groupMailInMainInbox: false }),
    });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ groupMailInMainInbox: false });

    const getRes = await app.request("/api/mail/preferences", {
      headers: { cookie: `session=${token}` },
    });
    expect(await getRes.json()).toEqual({ groupMailInMainInbox: false });
  });

  it("keeps the prior value on an empty PUT patch (merge, not overwrite)", async () => {
    const app = makeApp();

    const emptyPutRes = await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(emptyPutRes.status).toBe(200);
    expect(await emptyPutRes.json()).toEqual({ groupMailInMainInbox: false });

    const getRes = await app.request("/api/mail/preferences", {
      headers: { cookie: `session=${token}` },
    });
    expect(await getRes.json()).toEqual({ groupMailInMainInbox: false });
  });

  it("returns 400 invalid_body on malformed JSON", async () => {
    const res = await makeApp().request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });
});
