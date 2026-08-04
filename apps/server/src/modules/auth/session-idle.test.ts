import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createSessionStore } from "./sessions";

// #301: idle / sliding session timeout on top of the absolute TTL. A session is
// refreshed on every authenticated use (findUser), expires once idle beyond
// SESSION_IDLE_MINUTES, and can NEVER outlive its absolute `expires_at` ceiling.
const sql = createDb(testDatabaseUrl());

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

async function freshUserId(): Promise<string> {
  const user = await createUsersRepo(sql).create({
    email: `idle-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Idle User",
  });
  return user.id;
}

/** Backdates the last activity of every session a user owns, to fake idleness. */
async function ageLastSeen(userId: string, minutesAgo: number): Promise<void> {
  await sql`
    update sessions
    set last_seen_at = now() - make_interval(mins => ${minutesAgo}::int)
    where user_id = ${userId}
  `;
}

async function lastSeenAgeSeconds(userId: string): Promise<number> {
  const rows = await sql<{ age_seconds: number }[]>`
    select extract(epoch from (now() - last_seen_at))::float8 as age_seconds
    from sessions where user_id = ${userId}
  `;
  return rows[0]!.age_seconds;
}

describe("idle / sliding session timeout (#301)", () => {
  it("expires a session left idle beyond the idle window", async () => {
    const userId = await freshUserId();
    const store = createSessionStore(sql, { idleMinutes: 5 });
    const { token } = await store.create(userId, 12);

    // Used within the window: still valid.
    await ageLastSeen(userId, 3);
    expect(await store.findUser(token)).not.toBeNull();

    // Left idle past the window: expired, even though the absolute TTL (12h) has
    // barely started.
    await ageLastSeen(userId, 6);
    expect(await store.findUser(token)).toBeNull();
  });

  it("refreshes last_seen_at on each use, so continued activity keeps it alive", async () => {
    const userId = await freshUserId();
    const store = createSessionStore(sql, { idleMinutes: 5 });
    const { token } = await store.create(userId, 12);

    // 4 minutes idle (inside a 5-minute window): the access both succeeds AND
    // slides the window forward.
    await ageLastSeen(userId, 4);
    expect(await store.findUser(token)).not.toBeNull();
    expect(await lastSeenAgeSeconds(userId)).toBeLessThan(60);

    // Another 4 minutes from the refreshed point still lands inside the window,
    // where a non-sliding timeout (4 + 4 = 8 > 5) would already have expired.
    await ageLastSeen(userId, 4);
    expect(await store.findUser(token)).not.toBeNull();
  });

  it("never applies an idle limit when idleMinutes is unset", async () => {
    const userId = await freshUserId();
    const store = createSessionStore(sql); // no idle window
    const { token } = await store.create(userId, 12);

    // Idle for days: with no idle limit only the absolute TTL matters, so it
    // stays valid.
    await ageLastSeen(userId, 60 * 24 * 3);
    expect(await store.findUser(token)).not.toBeNull();
  });

  it("lets the absolute expiry win even when the session is freshly active", async () => {
    const userId = await freshUserId();
    // A generous idle window that would keep a fresh session alive on its own.
    const store = createSessionStore(sql, { idleMinutes: 60 });
    const { token } = await store.create(userId, 12);

    // Force the absolute ceiling into the past while last_seen stays "now": the
    // idle check passes, but the non-extensible absolute cap must still expire it.
    await sql`update sessions set expires_at = now() - interval '1 second' where user_id = ${userId}`;
    expect(await store.findUser(token)).toBeNull();
  });

  it("does not slide the absolute expiry forward on use", async () => {
    const userId = await freshUserId();
    const store = createSessionStore(sql, { idleMinutes: 60 });
    const { token } = await store.create(userId, 12);

    const before = await sql<{ expires_at: Date }[]>`
      select expires_at from sessions where user_id = ${userId}
    `;
    await store.findUser(token); // refreshes last_seen_at only
    const after = await sql<{ expires_at: Date }[]>`
      select expires_at from sessions where user_id = ${userId}
    `;
    expect(after[0]!.expires_at.getTime()).toBe(before[0]!.expires_at.getTime());
  });
});
