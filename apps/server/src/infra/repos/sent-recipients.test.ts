import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createSentRecipientsRepo } from "./sent-recipients";

const sql = createDb(testDatabaseUrl());
let repo: ReturnType<typeof createSentRecipientsRepo>;
let users: ReturnType<typeof createUsersRepo>;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  repo = createSentRecipientsRepo(sql);
  users = createUsersRepo(sql);
});
afterAll(() => sql.end());

async function freshUserId(): Promise<string> {
  const user = await users.create({
    email: `sr-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sent Recipients User",
  });
  return user.id;
}

// GH #314: the Tier A ("known sender") store — every address the user has
// written to. `record` is the write side fed by /send, the sent-mailbox
// harvest and the one-time backfill; `has` is the read side the thread route
// consults once per request for the distinct senders of a thread.
describe("createSentRecipientsRepo (GH #314)", () => {
  it("records recipients and reports them back, lowercased", async () => {
    const userId = await freshUserId();
    await repo.record(userId, ["Ana@Partner.Test", "bob@partner.test"]);
    const known = await repo.has(userId, ["ana@partner.test", "BOB@partner.test", "carol@partner.test"]);
    expect(known).toEqual(new Set(["ana@partner.test", "bob@partner.test"]));
  });

  it("is per user: one user's correspondents never make another user's sender 'known'", async () => {
    const alice = await freshUserId();
    const bob = await freshUserId();
    await repo.record(alice, ["shared@partner.test"]);
    expect(await repo.has(bob, ["shared@partner.test"])).toEqual(new Set());
  });

  it("ignores conflicts and keeps the first_sent_at of the original row", async () => {
    const userId = await freshUserId();
    await repo.record(userId, ["ana@partner.test"]);
    const [before] = await sql<{ first_sent_at: Date }[]>`
      select first_sent_at from sent_recipients where user_id = ${userId} and email = 'ana@partner.test'
    `;
    await repo.record(userId, ["ANA@partner.test", "ana@partner.test"]);
    const rows = await sql<{ first_sent_at: Date }[]>`
      select first_sent_at from sent_recipients where user_id = ${userId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.first_sent_at.getTime()).toBe(before?.first_sent_at.getTime());
  });

  it("drops blank and address-less entries and dedupes within one batch", async () => {
    const userId = await freshUserId();
    await repo.record(userId, ["  ", "", "not-an-address", "Ana@partner.test", "ana@partner.test "]);
    const rows = await sql<{ email: string }[]>`
      select email from sent_recipients where user_id = ${userId}
    `;
    expect(rows.map((row) => row.email)).toEqual(["ana@partner.test"]);
  });

  it("treats an empty batch as a no-op on both sides", async () => {
    const userId = await freshUserId();
    await expect(repo.record(userId, [])).resolves.toBeUndefined();
    expect(await repo.has(userId, [])).toEqual(new Set());
  });

  it("answers `has` in one query for the whole batch", async () => {
    const userId = await freshUserId();
    const many = Array.from({ length: 50 }, (_, i) => `r${i}@partner.test`);
    await repo.record(userId, many);
    const known = await repo.has(userId, [...many, "stranger@partner.test"]);
    expect(known.size).toBe(50);
    expect(known.has("stranger@partner.test")).toBe(false);
  });

  it("is removed with the user (on delete cascade)", async () => {
    const userId = await freshUserId();
    await repo.record(userId, ["ana@partner.test"]);
    await sql`delete from users where id = ${userId}`;
    const rows = await sql`select 1 from sent_recipients where user_id = ${userId}`;
    expect(rows).toHaveLength(0);
  });
});
