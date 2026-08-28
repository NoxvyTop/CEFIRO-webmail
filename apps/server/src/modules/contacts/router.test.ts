import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createContactsRepo } from "../../infra/repos/contacts";
import { createSessionStore } from "../auth/sessions";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createContactsRouter } from "./router";
import { contactSchema } from "@webmail/shared";

const sql = createDb(testDatabaseUrl());

let sessions: ReturnType<typeof createSessionStore>;
let contacts: ReturnType<typeof createContactsRepo>;
let token: string;
let token2: string;
let userId: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  contacts = createContactsRepo(sql);
  sessions = createSessionStore(sql);

  const user1 = await users.create({
    email: `contactsrt1-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Contacts Route User 1",
  });
  userId = user1.id;
  token = (await sessions.create(user1.id, 1)).token;

  const user2 = await users.create({
    email: `contactsrt2-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Contacts Route User 2",
  });
  token2 = (await sessions.create(user2.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp() {
  return createApp({
    contactsRouter: createContactsRouter({ sessions, contacts }),
  });
}

describe("contacts routes", () => {
  it("requires a session", async () => {
    const res = await makeApp().request("/api/mail/contacts");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_body on malformed JSON", async () => {
    const res = await makeApp().request("/api/mail/contacts", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 400 invalid_body on schema violation", async () => {
    const res = await makeApp().request("/api/mail/contacts", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "No Email" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("round-trips create, list and delete for the session user", async () => {
    const app = makeApp();

    const createRes = await app.request("/api/mail/contacts", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ana Lopez", email: "ana-route@x.com" }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as z.infer<typeof contactSchema>;
    expect(contactSchema.safeParse(created).success).toBe(true);
    expect(created.name).toBe("Ana Lopez");
    expect(created.source).toBe("manual");

    const listRes = await app.request("/api/mail/contacts", {
      headers: { cookie: `session=${token}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as z.infer<typeof contactSchema>[];
    expect(list.some((c) => c.id === created.id)).toBe(true);

    const deleteRes = await app.request(`/api/mail/contacts/${created.id}`, {
      method: "DELETE",
      headers: { cookie: `session=${token}` },
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });

    const afterDeleteList = (await (
      await app.request("/api/mail/contacts", { headers: { cookie: `session=${token}` } })
    ).json()) as z.infer<typeof contactSchema>[];
    expect(afterDeleteList.some((c) => c.id === created.id)).toBe(false);
  });

  it("returns 409 contact_exists when the same address is added twice in a different case", async () => {
    const app = makeApp();
    const email = `dup-route-${crypto.randomUUID()}@x.com`;

    const firstRes = await app.request("/api/mail/contacts", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "First", email: email.toUpperCase() }),
    });
    expect(firstRes.status).toBe(200);

    const secondRes = await app.request("/api/mail/contacts", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Second", email: email.toLowerCase() }),
    });
    expect(secondRes.status).toBe(409);
    expect(((await secondRes.json()) as { code: string }).code).toBe("contact_exists");
  });

  it("returns 404 when another user's session tries to delete a contact it does not own", async () => {
    const app = makeApp();

    const createRes = await app.request("/api/mail/contacts", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Owned", email: `owned-${crypto.randomUUID()}@x.com` }),
    });
    const owned = (await createRes.json()) as z.infer<typeof contactSchema>;

    const deleteRes = await app.request(`/api/mail/contacts/${owned.id}`, {
      method: "DELETE",
      headers: { cookie: `session=${token2}` },
    });
    expect(deleteRes.status).toBe(404);
  });

  it("returns 404 deleting a nonexistent contact", async () => {
    const app = makeApp();
    const res = await app.request(`/api/mail/contacts/${crypto.randomUUID()}`, {
      method: "DELETE",
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(404);
  });

  describe("POST /contacts/:id/promote", () => {
    // The harvest path has no route of its own (it runs off GET /api/mail/messages),
    // so a harvested row is seeded through the repo directly.
    async function seedHarvested(name: string): Promise<z.infer<typeof contactSchema>> {
      const email = `harvestroute-${crypto.randomUUID()}@x.com`;
      await contacts.harvestSenders(userId, [{ name, email }]);
      const found = (await contacts.list(userId)).find((c) => c.email === email);
      expect(found?.source).toBe("harvested");
      return found!;
    }

    it("requires a session", async () => {
      const res = await makeApp().request(`/api/mail/contacts/${crypto.randomUUID()}/promote`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("promotes a harvested contact and returns it as manual", async () => {
      const app = makeApp();
      const harvested = await seedHarvested("Promote Me");

      const res = await app.request(`/api/mail/contacts/${harvested.id}/promote`, {
        method: "POST",
        headers: { cookie: `session=${token}` },
      });
      expect(res.status).toBe(200);
      const promoted = (await res.json()) as z.infer<typeof contactSchema>;
      expect(contactSchema.safeParse(promoted).success).toBe(true);
      expect(promoted.source).toBe("manual");
      expect(promoted.id).toBe(harvested.id);

      const list = (await (
        await app.request("/api/mail/contacts", { headers: { cookie: `session=${token}` } })
      ).json()) as z.infer<typeof contactSchema>[];
      expect(list.find((c) => c.id === harvested.id)?.source).toBe("manual");
    });

    it("returns 404 when another user's session tries to promote a contact it does not own", async () => {
      const app = makeApp();
      const harvested = await seedHarvested("Not Yours Either");

      const res = await app.request(`/api/mail/contacts/${harvested.id}/promote`, {
        method: "POST",
        headers: { cookie: `session=${token2}` },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
    });

    it("returns 404 promoting a nonexistent contact", async () => {
      const res = await makeApp().request(
        `/api/mail/contacts/${crypto.randomUUID()}/promote`,
        { method: "POST", headers: { cookie: `session=${token}` } },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /contacts/search", () => {
    it("returns an empty list below the minimum query length", async () => {
      const app = makeApp();
      await app.request("/api/mail/contacts", {
        method: "POST",
        headers: { cookie: `session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Short Query Match", email: `s-${crypto.randomUUID()}@x.com` }),
      });

      const res = await app.request("/api/mail/contacts/search?q=s", {
        headers: { cookie: `session=${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("returns an empty list for an empty query", async () => {
      const res = await makeApp().request("/api/mail/contacts/search", {
        headers: { cookie: `session=${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("matches by name prefix and by email prefix, case-insensitively, and caps results", async () => {
      const app = makeApp();
      const suffix = crypto.randomUUID();
      for (let i = 0; i < 15; i++) {
        await app.request("/api/mail/contacts", {
          method: "POST",
          headers: { cookie: `session=${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            name: `Zzsearch${suffix} Person ${i}`,
            email: `zzsearch${suffix}${i}@x.com`,
          }),
        });
      }

      const byName = await app.request(
        `/api/mail/contacts/search?q=${encodeURIComponent(`ZZSEARCH${suffix}`)}`,
        { headers: { cookie: `session=${token}` } },
      );
      expect(byName.status).toBe(200);
      const byNameResults = (await byName.json()) as z.infer<typeof contactSchema>[];
      expect(byNameResults.length).toBeLessThanOrEqual(10);
      expect(byNameResults.length).toBeGreaterThan(0);

      const byEmail = await app.request(
        `/api/mail/contacts/search?q=${encodeURIComponent(`zzsearch${suffix}3`)}`,
        { headers: { cookie: `session=${token}` } },
      );
      const byEmailResults = (await byEmail.json()) as z.infer<typeof contactSchema>[];
      expect(byEmailResults.some((c) => c.email === `zzsearch${suffix}3@x.com`)).toBe(true);
    });

    it("does not return another user's contacts", async () => {
      const app = makeApp();
      const suffix = crypto.randomUUID();
      await app.request("/api/mail/contacts", {
        method: "POST",
        headers: { cookie: `session=${token2}`, "content-type": "application/json" },
        body: JSON.stringify({ name: `Isolated${suffix}`, email: `isolated${suffix}@x.com` }),
      });

      const res = await app.request(
        `/api/mail/contacts/search?q=${encodeURIComponent(`isolated${suffix}`)}`,
        { headers: { cookie: `session=${token}` } },
      );
      expect(await res.json()).toEqual([]);
    });
  });
});
