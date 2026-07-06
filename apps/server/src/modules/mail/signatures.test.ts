import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import { signatureSchema } from "@webmail/shared";
import type { JmapClient } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let signatures: ReturnType<typeof createSignaturesRepo>;
let token: string;
let token2: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  signatures = createSignaturesRepo(sql);
  sessions = createSessionStore(sql);

  const user1 = await users.create({
    email: `sig1-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Signature User 1",
  });
  token = (await sessions.create(user1.id, 1)).token;

  const user2 = await users.create({
    email: `sig2-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Signature User 2",
  });
  token2 = (await sessions.create(user2.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp(jmap: JmapClient | null) {
  return createApp({
    mailRouter: createMailRouter({ sessions, mailCredentials, signatures, jmap }),
  });
}

describe("signatures routes", () => {
  it("requires a session", async () => {
    const res = await makeApp(null).request("/api/mail/signatures");
    expect(res.status).toBe(401);
  });

  it("works with jmap: null (no stalwart configured)", async () => {
    const res = await makeApp(null).request("/api/mail/signatures", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(z.array(signatureSchema).safeParse(body).success).toBe(true);
  });

  it("returns 400 invalid_body on malformed JSON", async () => {
    const res = await makeApp(null).request("/api/mail/signatures", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 400 invalid_body on schema violation", async () => {
    const res = await makeApp(null).request("/api/mail/signatures", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "", contentHtml: "<p>hi</p>" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("round-trips CRUD for the session user", async () => {
    const app = makeApp(null);

    const createRes = await app.request("/api/mail/signatures", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Work", contentHtml: "<p>Regards</p>", isDefault: false }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as z.infer<typeof signatureSchema>;
    expect(signatureSchema.safeParse(created).success).toBe(true);
    expect(created.name).toBe("Work");
    expect(created.isDefault).toBe(false);

    const listRes = await app.request("/api/mail/signatures", {
      headers: { cookie: `session=${token}` },
    });
    const list = (await listRes.json()) as z.infer<typeof signatureSchema>[];
    expect(list.some((s) => s.id === created.id)).toBe(true);

    const updateRes = await app.request(`/api/mail/signatures/${created.id}`, {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Work Updated", contentHtml: "<p>Best</p>", isDefault: false }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as z.infer<typeof signatureSchema>;
    expect(updated.name).toBe("Work Updated");
    expect(updated.contentHtml).toBe("<p>Best</p>");

    const deleteRes = await app.request(`/api/mail/signatures/${created.id}`, {
      method: "DELETE",
      headers: { cookie: `session=${token}` },
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });

    const afterDeleteRes = await app.request(`/api/mail/signatures/${created.id}`, {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ghost", contentHtml: "<p>Gone</p>", isDefault: false }),
    });
    expect(afterDeleteRes.status).toBe(404);
  });

  it("clears other defaults when a new signature is marked default", async () => {
    const app = makeApp(null);

    const aRes = await app.request("/api/mail/signatures", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Default A", contentHtml: "<p>A</p>", isDefault: true }),
    });
    const a = (await aRes.json()) as z.infer<typeof signatureSchema>;
    expect(a.isDefault).toBe(true);

    const bRes = await app.request("/api/mail/signatures", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Default B", contentHtml: "<p>B</p>", isDefault: true }),
    });
    const b = (await bRes.json()) as z.infer<typeof signatureSchema>;
    expect(b.isDefault).toBe(true);

    const listRes = await app.request("/api/mail/signatures", {
      headers: { cookie: `session=${token}` },
    });
    const list = (await listRes.json()) as z.infer<typeof signatureSchema>[];
    const refreshedA = list.find((s) => s.id === a.id);
    const refreshedB = list.find((s) => s.id === b.id);
    expect(refreshedA?.isDefault).toBe(false);
    expect(refreshedB?.isDefault).toBe(true);
    // default-first ordering
    expect(list[0]?.id).toBe(b.id);
  });

  it("returns 404 when another user's session tries to update or delete a signature it does not own", async () => {
    const app = makeApp(null);

    const createRes = await app.request("/api/mail/signatures", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Owned", contentHtml: "<p>Mine</p>", isDefault: false }),
    });
    const owned = (await createRes.json()) as z.infer<typeof signatureSchema>;

    const updateRes = await app.request(`/api/mail/signatures/${owned.id}`, {
      method: "PUT",
      headers: { cookie: `session=${token2}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Hijacked", contentHtml: "<p>Nope</p>", isDefault: false }),
    });
    expect(updateRes.status).toBe(404);

    const deleteRes = await app.request(`/api/mail/signatures/${owned.id}`, {
      method: "DELETE",
      headers: { cookie: `session=${token2}` },
    });
    expect(deleteRes.status).toBe(404);
  });

  it("keeps default signature intact when update target is missing", async () => {
    const app = makeApp(null);

    const s1Res = await app.request("/api/mail/signatures", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Default Sig", contentHtml: "<p>Default</p>", isDefault: true }),
    });
    const s1 = (await s1Res.json()) as z.infer<typeof signatureSchema>;
    expect(s1.isDefault).toBe(true);

    const nonexistentId = crypto.randomUUID();
    const updateRes = await app.request(`/api/mail/signatures/${nonexistentId}`, {
      method: "PUT",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ghost", contentHtml: "<p>Gone</p>", isDefault: true }),
    });
    expect(updateRes.status).toBe(404);

    const listRes = await app.request("/api/mail/signatures", {
      headers: { cookie: `session=${token}` },
    });
    const list = (await listRes.json()) as z.infer<typeof signatureSchema>[];
    const refreshedS1 = list.find((s) => s.id === s1.id);
    expect(refreshedS1?.isDefault).toBe(true);
  });
});
