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

  it("defaults groupMailInMainInbox to true and customLabels to [] before any set", async () => {
    const res = await makeApp().request("/api/mail/preferences", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groupMailInMainInbox: true, customLabels: [] });
  });

  it("persists a PUT and reflects it on a subsequent GET", async () => {
    const app = makeApp();

    const putRes = await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ groupMailInMainInbox: false }),
    });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ groupMailInMainInbox: false, customLabels: [] });

    const getRes = await app.request("/api/mail/preferences", {
      headers: { cookie: `session=${token}` },
    });
    expect(await getRes.json()).toEqual({ groupMailInMainInbox: false, customLabels: [] });
  });

  it("keeps the prior value on an empty PUT patch (merge, not overwrite)", async () => {
    const app = makeApp();

    const emptyPutRes = await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(emptyPutRes.status).toBe(200);
    expect(await emptyPutRes.json()).toEqual({ groupMailInMainInbox: false, customLabels: [] });

    const getRes = await app.request("/api/mail/preferences", {
      headers: { cookie: `session=${token}` },
    });
    expect(await getRes.json()).toEqual({ groupMailInMainInbox: false, customLabels: [] });
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

describe("custom labels persistence (preferences.customLabels)", () => {
  it("persists custom labels via PUT and reflects them on GET", async () => {
    const app = makeApp();
    const label = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };

    const putRes = await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ customLabels: [label] }),
    });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toMatchObject({ customLabels: [label] });

    const getRes = await app.request("/api/mail/preferences", {
      headers: { cookie: `session=${token}` },
    });
    expect(await getRes.json()).toMatchObject({ customLabels: [label] });
  });

  it("replaces the whole customLabels array on a subsequent PUT (full-array patch, not append)", async () => {
    const app = makeApp();
    const first = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
    const second = { slug: "soporte", name: "Soporte", color: "#2FB8C4" };

    await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ customLabels: [first] }),
    });
    const putRes = await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ customLabels: [first, second] }),
    });
    expect(await putRes.json()).toMatchObject({ customLabels: [first, second] });

    const deleteRes = await app.request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ customLabels: [second] }),
    });
    expect(await deleteRes.json()).toMatchObject({ customLabels: [second] });
  });

  it("returns 400 invalid_body when a custom label has an invalid slug", async () => {
    const res = await makeApp().request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ customLabels: [{ slug: "Not A Slug", name: "x", color: "#9B6BDB" }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 400 invalid_body when a custom label has an invalid color", async () => {
    const res = await makeApp().request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ customLabels: [{ slug: "ventas", name: "Ventas", color: "not-a-color" }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 400 invalid_body when customLabels has duplicate slugs (case-insensitive)", async () => {
    const res = await makeApp().request("/api/mail/preferences", {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        customLabels: [
          { slug: "ventas", name: "Ventas", color: "#9B6BDB" },
          { slug: "VENTAS", name: "Ventas otra vez", color: "#E8639C" },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("defensively drops a malformed stored customLabels entry instead of failing the GET", async () => {
    const users = createUsersRepo(sql);
    const user = await users.create({
      email: `prefs-corrupt-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Corrupt Prefs User",
    });
    const corruptToken = (await sessions.create(user.id, 1)).token;
    // Bypass the API's zod validation to simulate a legacy/corrupted row.
    await sql`
      insert into user_preferences (user_id, preferences)
      values (${user.id}, ${sql.json({ customLabels: [{ slug: "ok-one", name: "Ok", color: "#9B6BDB" }, { slug: "bad" }] } as never)})
    `;

    const res = await makeApp().request("/api/mail/preferences", {
      headers: { cookie: `session=${corruptToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groupMailInMainInbox: true,
      customLabels: [{ slug: "ok-one", name: "Ok", color: "#9B6BDB" }],
    });
  });
});
