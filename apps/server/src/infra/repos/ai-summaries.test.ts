import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createAiSummariesRepo } from "./ai-summaries";

const sql = createDb(testDatabaseUrl());

let users: ReturnType<typeof createUsersRepo>;
let repo: ReturnType<typeof createAiSummariesRepo>;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  users = createUsersRepo(sql);
  repo = createAiSummariesRepo(sql);
});
afterAll(() => sql.end());

async function makeUser() {
  return users.create({
    email: `ai-sum-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "AI Summary User",
  });
}

describe("ai summaries repo", () => {
  it("returns null on a miss", async () => {
    const user = await makeUser();
    expect(await repo.get(user.id, "message", "no-such-id", "no-such-id")).toBeNull();
  });

  it("stores bullets and reads them back for the same key", async () => {
    const user = await makeUser();
    await repo.put(user.id, "message", "m1", "m1", ["uno", "dos", "tres"]);
    expect(await repo.get(user.id, "message", "m1", "m1")).toEqual(["uno", "dos", "tres"]);
  });

  it("keeps message and thread entries for the same target apart by kind", async () => {
    const user = await makeUser();
    await repo.put(user.id, "message", "x1", "x1", ["msg"]);
    await repo.put(user.id, "thread", "x1", "hash-a", ["thread"]);
    expect(await repo.get(user.id, "message", "x1", "x1")).toEqual(["msg"]);
    expect(await repo.get(user.id, "thread", "x1", "hash-a")).toEqual(["thread"]);
  });

  it("misses when the content_key differs (a grown thread)", async () => {
    const user = await makeUser();
    await repo.put(user.id, "thread", "t1", "hash-old", ["stale"]);
    // A new message changes the id set → a new content_key → a miss.
    expect(await repo.get(user.id, "thread", "t1", "hash-new")).toBeNull();
    expect(await repo.get(user.id, "thread", "t1", "hash-old")).toEqual(["stale"]);
  });

  it("upserts the same key in place instead of duplicating", async () => {
    const user = await makeUser();
    await repo.put(user.id, "message", "m2", "m2", ["first"]);
    await repo.put(user.id, "message", "m2", "m2", ["second"]);
    expect(await repo.get(user.id, "message", "m2", "m2")).toEqual(["second"]);
    const rows = await sql`
      select 1 from email_ai_summaries
      where user_id = ${user.id} and kind = 'message' and target_id = 'm2'
    `;
    expect(rows).toHaveLength(1);
  });

  it("scopes entries per user (one user's cache never serves another)", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await repo.put(alice.id, "message", "shared-id", "shared-id", ["alice"]);
    expect(await repo.get(bob.id, "message", "shared-id", "shared-id")).toBeNull();
  });

  it("cascades entries away when the user is deleted", async () => {
    const user = await makeUser();
    await repo.put(user.id, "message", "m3", "m3", ["bye"]);
    await sql`delete from users where id = ${user.id}`;
    const rows = await sql`select 1 from email_ai_summaries where user_id = ${user.id}`;
    expect(rows).toHaveLength(0);
  });
});
