import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createContactsRepo } from "./contacts";

const sql = createDb(testDatabaseUrl());

let userId: string;
let otherUserId: string;
const contacts = createContactsRepo(sql);

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const user1 = await users.create({
    email: `contacts1-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Contacts User 1",
  });
  userId = user1.id;
  const user2 = await users.create({
    email: `contacts2-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Contacts User 2",
  });
  otherUserId = user2.id;
});
afterAll(() => sql.end());

describe("contacts repo", () => {
  it("creates, lists and deletes a contact", async () => {
    const created = await contacts.create(userId, { name: "Ana Lopez", email: "ana@x.com" });
    expect(created).not.toBeNull();
    expect(created?.name).toBe("Ana Lopez");
    expect(created?.email).toBe("ana@x.com");
    expect(created?.source).toBe("manual");

    const list = await contacts.list(userId);
    expect(list.some((c) => c.id === created?.id)).toBe(true);

    const removed = await contacts.remove(userId, created!.id);
    expect(removed).toBe(true);

    const afterDelete = await contacts.list(userId);
    expect(afterDelete.some((c) => c.id === created?.id)).toBe(false);
  });

  it("does not duplicate the same address in a different case", async () => {
    const first = await contacts.create(userId, { name: "Bob", email: "Bob@X.com" });
    expect(first).not.toBeNull();

    const second = await contacts.create(userId, { name: "Bob Again", email: "bob@x.com" });
    expect(second).toBeNull();

    const list = await contacts.list(userId);
    const matches = list.filter((c) => c.email.toLowerCase() === "bob@x.com");
    expect(matches).toHaveLength(1);
  });

  it("refuses to delete another user's contact", async () => {
    const created = await contacts.create(userId, { name: "Carla", email: "carla@x.com" });
    expect(created).not.toBeNull();

    const removedByOther = await contacts.remove(otherUserId, created!.id);
    expect(removedByOther).toBe(false);

    const list = await contacts.list(userId);
    expect(list.some((c) => c.id === created?.id)).toBe(true);
  });

  describe("search", () => {
    it("matches a name prefix and an email prefix, case-insensitively", async () => {
      await contacts.create(userId, { name: "Diana Prince", email: "diana@wonder.com" });
      await contacts.create(userId, { name: "Zed", email: "diamond@zed.com" });
      await contacts.create(userId, { name: "No Match", email: "nomatch@x.com" });

      const byName = await contacts.search(userId, "dia", 10);
      expect(byName.map((c) => c.email).sort()).toEqual(
        ["diamond@zed.com", "diana@wonder.com"].sort(),
      );

      const byNameUpper = await contacts.search(userId, "DIA", 10);
      expect(byNameUpper.length).toBe(byName.length);

      const byEmail = await contacts.search(userId, "diana@", 10);
      expect(byEmail.map((c) => c.email)).toEqual(["diana@wonder.com"]);
    });

    it("caps the number of results", async () => {
      for (let i = 0; i < 5; i++) {
        await contacts.create(userId, { name: `Capped ${i}`, email: `capped${i}@x.com` });
      }
      const results = await contacts.search(userId, "capped", 3);
      expect(results).toHaveLength(3);
    });

    it("only returns the searching user's contacts", async () => {
      await contacts.create(otherUserId, { name: "Foreign Match", email: "foreignmatch@x.com" });
      const results = await contacts.search(userId, "foreignmatch", 10);
      expect(results).toHaveLength(0);
    });
  });

  describe("promote", () => {
    it("turns a harvested contact into a manual one", async () => {
      const email = `promote-${crypto.randomUUID()}@x.com`;
      await contacts.harvestSenders(userId, [{ name: "Seen Once", email }]);
      const harvested = (await contacts.list(userId)).find((c) => c.email === email);
      expect(harvested?.source).toBe("harvested");

      const promoted = await contacts.promote(userId, harvested!.id);
      expect(promoted?.source).toBe("manual");
      // The rest of the row is untouched — promotion only changes provenance.
      expect(promoted?.name).toBe("Seen Once");
      expect(promoted?.email).toBe(email);

      const afterPromote = (await contacts.list(userId)).find((c) => c.email === email);
      expect(afterPromote?.source).toBe("manual");
    });

    it("is idempotent for a contact that is already manual", async () => {
      const created = await contacts.create(userId, {
        name: "Already Mine",
        email: `already-${crypto.randomUUID()}@x.com`,
      });

      const promoted = await contacts.promote(userId, created!.id);
      expect(promoted?.source).toBe("manual");
      expect(promoted?.id).toBe(created!.id);
    });

    it("refuses to promote another user's contact", async () => {
      const email = `foreignpromote-${crypto.randomUUID()}@x.com`;
      await contacts.harvestSenders(userId, [{ name: "Not Yours", email }]);
      const harvested = (await contacts.list(userId)).find((c) => c.email === email);

      const promoted = await contacts.promote(otherUserId, harvested!.id);
      expect(promoted).toBeNull();

      const stillHarvested = (await contacts.list(userId)).find((c) => c.email === email);
      expect(stillHarvested?.source).toBe("harvested");
    });

    it("returns null for an unknown id", async () => {
      expect(await contacts.promote(userId, crypto.randomUUID())).toBeNull();
    });
  });

  describe("harvestSenders", () => {
    it("bulk-adds new harvested senders in one call", async () => {
      const email1 = `harvest1-${crypto.randomUUID()}@x.com`;
      const email2 = `harvest2-${crypto.randomUUID()}@x.com`;
      await contacts.harvestSenders(userId, [
        { name: "Harvested One", email: email1 },
        { name: "Harvested Two", email: email2 },
      ]);

      const list = await contacts.list(userId);
      const first = list.find((c) => c.email === email1);
      const second = list.find((c) => c.email === email2);
      expect(first?.source).toBe("harvested");
      expect(second?.source).toBe("harvested");
    });

    it("does not overwrite an existing contact's name", async () => {
      const email = `existing-${crypto.randomUUID()}@x.com`;
      await contacts.create(userId, { name: "Original Name", email });

      await contacts.harvestSenders(userId, [{ name: "Harvested Rename", email }]);

      const list = await contacts.list(userId);
      const found = list.find((c) => c.email === email);
      expect(found?.name).toBe("Original Name");
      expect(found?.source).toBe("manual");
    });

    it("never resurrects a contact the user deleted", async () => {
      const email = `deleted-${crypto.randomUUID()}@x.com`;
      const created = await contacts.create(userId, { name: "To Delete", email });
      expect(created).not.toBeNull();
      await contacts.remove(userId, created!.id);

      await contacts.harvestSenders(userId, [{ name: "Trying To Come Back", email }]);

      const list = await contacts.list(userId);
      expect(list.some((c) => c.email === email)).toBe(false);
    });

    it("does nothing when given an empty list", async () => {
      await expect(contacts.harvestSenders(userId, [])).resolves.toBeUndefined();
    });
  });
});
