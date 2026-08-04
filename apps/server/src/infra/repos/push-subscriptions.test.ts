import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createPushSubscriptionsRepo } from "./push-subscriptions";

const sql = createDb(testDatabaseUrl());

let users: ReturnType<typeof createUsersRepo>;
let repo: ReturnType<typeof createPushSubscriptionsRepo>;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  users = createUsersRepo(sql);
  repo = createPushSubscriptionsRepo(sql);
});
afterAll(() => sql.end());

async function makeUser() {
  return users.create({
    email: `push-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Push User",
  });
}

function endpoint() {
  return `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
}

describe("push subscriptions repo", () => {
  it("stores a subscription and lists it back for the user", async () => {
    const user = await makeUser();
    const ep = endpoint();
    await repo.upsert({
      userId: user.id,
      endpoint: ep,
      p256dh: "key-a",
      auth: "auth-a",
      userAgent: "Firefox/128",
    });

    const list = await repo.listByUser(user.id);
    expect(list).toEqual([{ endpoint: ep, p256dh: "key-a", auth: "auth-a" }]);
  });

  it("upserts by endpoint: a re-subscribe updates keys in place instead of duplicating", async () => {
    const user = await makeUser();
    const ep = endpoint();
    await repo.upsert({ userId: user.id, endpoint: ep, p256dh: "key-1", auth: "auth-1" });
    await repo.upsert({ userId: user.id, endpoint: ep, p256dh: "key-2", auth: "auth-2" });

    const list = await repo.listByUser(user.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ endpoint: ep, p256dh: "key-2", auth: "auth-2" });

    // The unique constraint is what makes this a single row across the DB.
    const rows = await sql`select 1 from push_subscriptions where endpoint = ${ep}`;
    expect(rows).toHaveLength(1);
  });

  it("re-points an endpoint at whoever subscribed last (handed-over device)", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const ep = endpoint();
    await repo.upsert({ userId: alice.id, endpoint: ep, p256dh: "k", auth: "a" });
    await repo.upsert({ userId: bob.id, endpoint: ep, p256dh: "k2", auth: "a2" });

    expect(await repo.listByUser(alice.id)).toHaveLength(0);
    expect(await repo.listByUser(bob.id)).toEqual([{ endpoint: ep, p256dh: "k2", auth: "a2" }]);
  });

  it("deletes a dead endpoint regardless of owner (expiry path)", async () => {
    const user = await makeUser();
    const ep = endpoint();
    await repo.upsert({ userId: user.id, endpoint: ep, p256dh: "k", auth: "a" });
    await repo.deleteByEndpoint(ep);
    expect(await repo.listByUser(user.id)).toHaveLength(0);
  });

  it("deletes only the session user's own endpoint (opt-out path)", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const aliceEp = endpoint();
    const bobEp = endpoint();
    await repo.upsert({ userId: alice.id, endpoint: aliceEp, p256dh: "k", auth: "a" });
    await repo.upsert({ userId: bob.id, endpoint: bobEp, p256dh: "k", auth: "a" });

    // Bob cannot drop Alice's subscription by naming her endpoint.
    await repo.deleteByUserAndEndpoint(bob.id, aliceEp);
    expect(await repo.listByUser(alice.id)).toHaveLength(1);

    await repo.deleteByUserAndEndpoint(alice.id, aliceEp);
    expect(await repo.listByUser(alice.id)).toHaveLength(0);
  });

  it("cascades subscriptions away when the user is deleted", async () => {
    const user = await makeUser();
    const ep = endpoint();
    await repo.upsert({ userId: user.id, endpoint: ep, p256dh: "k", auth: "a" });
    await sql`delete from users where id = ${user.id}`;
    const rows = await sql`select 1 from push_subscriptions where endpoint = ${ep}`;
    expect(rows).toHaveLength(0);
  });
});
