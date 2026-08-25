import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createUserPreferencesRepo } from "./user-preferences";

const sql = createDb(testDatabaseUrl());
let repo: ReturnType<typeof createUserPreferencesRepo>;
let users: ReturnType<typeof createUsersRepo>;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  repo = createUserPreferencesRepo(sql);
  users = createUsersRepo(sql);
});
afterAll(() => sql.end());

async function freshUserId(): Promise<string> {
  const user = await users.create({
    email: `p-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Pref User",
  });
  return user.id;
}

describe("createUserPreferencesRepo — sharedMailboxCopyOptIn (GH #13/#50 G-3)", () => {
  it("defaults to an empty list for a user with no stored preferences", async () => {
    const userId = await freshUserId();
    const prefs = await repo.get(userId);
    expect(prefs.sharedMailboxCopyOptIn).toEqual([]);
    // The pre-existing fields keep their own defaults.
    expect(prefs.groupMailInMainInbox).toBe(true);
    expect(prefs.customLabels).toEqual([]);
  });

  it("persists a merged opt-in list and reads it back, leaving other fields untouched", async () => {
    const userId = await freshUserId();
    await repo.merge(userId, { groupMailInMainInbox: false });
    const merged = await repo.merge(userId, {
      sharedMailboxCopyOptIn: ["acc-shared", "acc-soporte"],
    });
    expect(merged.sharedMailboxCopyOptIn).toEqual(["acc-shared", "acc-soporte"]);
    // The earlier field is not clobbered by the second merge.
    expect(merged.groupMailInMainInbox).toBe(false);

    const reread = await repo.get(userId);
    expect(reread.sharedMailboxCopyOptIn).toEqual(["acc-shared", "acc-soporte"]);
  });

  it("defensively drops non-string, empty and duplicate entries from a hand-written row", async () => {
    const userId = await freshUserId();
    await sql`
      insert into user_preferences (user_id, preferences)
      values (
        ${userId},
        ${sql.json({
          sharedMailboxCopyOptIn: ["a", "a", "", 5, null, "b"],
          // A non-array customLabels exercises parseCustomLabels' guard too.
          customLabels: "not-an-array",
        })}
      )
    `;
    const prefs = await repo.get(userId);
    expect(prefs.sharedMailboxCopyOptIn).toEqual(["a", "b"]);
    expect(prefs.customLabels).toEqual([]);
  });
});

// GH #314: the user's confirmed trusted-service domains (Tier B). The PUT/DELETE
// routes always write a clean, normalized list, so the parse only guards rows
// written by hand — but those guards matter more than usual here, because
// whatever survives the parse becomes a trust decision on the reader.
describe("createUserPreferencesRepo — trustedServices (GH #314)", () => {
  it("defaults to an empty list for a user with no stored preferences", async () => {
    const userId = await freshUserId();
    const prefs = await repo.get(userId);
    expect(prefs.trustedServices).toEqual([]);
  });

  it("persists a merged domain list and reads it back, leaving other fields untouched", async () => {
    const userId = await freshUserId();
    await repo.merge(userId, { sharedMailboxCopyOptIn: ["acc-shared"] });
    const merged = await repo.merge(userId, { trustedServices: ["partner.test", "billing.example"] });
    expect(merged.trustedServices).toEqual(["partner.test", "billing.example"]);
    expect(merged.sharedMailboxCopyOptIn).toEqual(["acc-shared"]);

    const reread = await repo.get(userId);
    expect(reread.trustedServices).toEqual(["partner.test", "billing.example"]);
  });

  it("defensively lowercases, trims, dedupes and drops non-domain entries from a hand-written row", async () => {
    const userId = await freshUserId();
    await sql`
      insert into user_preferences (user_id, preferences)
      values (
        ${userId},
        ${sql.json({
          trustedServices: [
            " Partner.Test ",
            "partner.test",
            "",
            5,
            null,
            "not a domain",
            "user@evil.test",
            ".leading.dot",
            "com",
            "billing.example",
          ],
        })}
      )
    `;
    const prefs = await repo.get(userId);
    expect(prefs.trustedServices).toEqual(["partner.test", "billing.example"]);
  });

  it("falls back to the empty list when the stored value is not an array", async () => {
    const userId = await freshUserId();
    await sql`
      insert into user_preferences (user_id, preferences)
      values (${userId}, ${sql.json({ trustedServices: "github.com" })})
    `;
    expect((await repo.get(userId)).trustedServices).toEqual([]);
  });

  it("caps the list at 200 entries so a runaway row cannot make every thread read expensive", async () => {
    const userId = await freshUserId();
    const many = Array.from({ length: 250 }, (_, i) => `svc-${i}.example`);
    await sql`
      insert into user_preferences (user_id, preferences)
      values (${userId}, ${sql.json({ trustedServices: many })})
    `;
    const prefs = await repo.get(userId);
    expect(prefs.trustedServices).toHaveLength(200);
    expect(prefs.trustedServices[0]).toBe("svc-0.example");
    expect(prefs.trustedServices[199]).toBe("svc-199.example");
  });
});
