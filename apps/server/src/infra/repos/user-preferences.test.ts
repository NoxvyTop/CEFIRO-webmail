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
