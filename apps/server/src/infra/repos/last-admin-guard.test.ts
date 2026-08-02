import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo, type UserRecord } from "./users";

// GH #45. The invariant under test — "this instance always has at least one
// active admin" — is a property of the WHOLE users table, so the test has to
// own the active-admin population while it runs. Files that ran earlier on this
// worker slot leave admins of their own behind; they are archived for the
// duration here and restored afterwards.
//
// Safe because the database is a throwaway one, provisioned per WORKER SLOT
// (vitest.global-setup.ts, src/infra/db/test-db.ts — GH #14), and vitest runs at
// most one file per slot at a time. No concurrently-running file can see this
// table, and the ones that reuse the slot afterwards find it as they left it.
const sql = createDb(testDatabaseUrl());
const users = createUsersRepo(sql);

/** Ids archived by `takeOverAdmins`, restored in afterAll. */
let borrowedAdmins: string[] = [];

async function createAdmin(): Promise<UserRecord> {
  return users.create({
    email: `guard-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Guard Admin",
    role: "admin",
  });
}

/** Archives every admin this test file did not create, so the count is ours. */
async function takeOverAdmins(): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    update users set active = false
    where role = 'admin' and active = true
    returning id
  `;
  borrowedAdmins = rows.map((row) => row.id);
}

async function activeAdminIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from users where role = 'admin' and active = true order by id
  `;
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  await takeOverAdmins();
});

// Each test leaves its own admins behind; clear them so the next one starts
// from an empty active-admin set rather than inheriting a count.
afterEach(async () => {
  await sql`update users set active = false where role = 'admin' and active = true`;
});

afterAll(async () => {
  if (borrowedAdmins.length > 0) {
    await sql`update users set active = true where id in ${sql(borrowedAdmins)}`;
  }
  await sql.end();
});

describe("last-admin guard is transactional (GH #45)", () => {
  it("refuses to demote the only active admin", async () => {
    const only = await createAdmin();

    const result = await users.setRoleGuarded(only.id, "employee");

    expect(result.outcome).toBe("last_admin");
    expect((await users.findById(only.id))?.role).toBe("admin");
  });

  it("refuses to archive the only active admin", async () => {
    const only = await createAdmin();

    const result = await users.setActiveGuarded(only.id, false);

    expect(result.outcome).toBe("last_admin");
    expect((await users.findById(only.id))?.active).toBe(true);
  });

  it("allows the demotion while a second active admin remains", async () => {
    const first = await createAdmin();
    await createAdmin();

    const result = await users.setRoleGuarded(first.id, "employee");

    expect(result).toEqual({
      outcome: "updated",
      user: expect.objectContaining({ id: first.id, role: "employee" }),
    });
  });

  it("allows archiving an admin who is not the last one", async () => {
    const first = await createAdmin();
    await createAdmin();

    const result = await users.setActiveGuarded(first.id, false);

    expect(result).toEqual({
      outcome: "updated",
      user: expect.objectContaining({ id: first.id, active: false }),
    });
  });

  // The regression the issue is about: before this, the count and the write were
  // two round trips, so both of these read 2, both passed the guard, and the
  // instance was left with zero admins — locked out with no way back in.
  it("lets only ONE of two concurrent demotions of different admins through", async () => {
    const first = await createAdmin();
    const second = await createAdmin();

    const results = await Promise.all([
      users.setRoleGuarded(first.id, "employee"),
      users.setRoleGuarded(second.id, "employee"),
    ]);

    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["last_admin", "updated"]);
    expect(await activeAdminIds()).toHaveLength(1);
  });

  it("lets only ONE of two concurrent archives of different admins through", async () => {
    const first = await createAdmin();
    const second = await createAdmin();

    const results = await Promise.all([
      users.setActiveGuarded(first.id, false),
      users.setActiveGuarded(second.id, false),
    ]);

    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["last_admin", "updated"]);
    expect(await activeAdminIds()).toHaveLength(1);
  });

  // Mixed shapes of the same race: one request demotes an admin while another
  // archives a different one. Either write alone is fine; together they are the
  // same lockout.
  it("lets only ONE of a concurrent demotion and archive through", async () => {
    const first = await createAdmin();
    const second = await createAdmin();

    const results = await Promise.all([
      users.setRoleGuarded(first.id, "employee"),
      users.setActiveGuarded(second.id, false),
    ]);

    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["last_admin", "updated"]);
    expect(await activeAdminIds()).toHaveLength(1);
  });

  it("reports not_found for an id that does not exist", async () => {
    // Two active admins so the guard itself cannot be what answers.
    await createAdmin();
    await createAdmin();

    expect(await users.setRoleGuarded(crypto.randomUUID(), "employee")).toEqual({
      outcome: "not_found",
    });
    expect(await users.setActiveGuarded(crypto.randomUUID(), false)).toEqual({
      outcome: "not_found",
    });
  });

  it("never refuses a write that cannot remove an admin", async () => {
    const only = await createAdmin();
    const employee = await users.create({
      email: `guard-emp-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Guard Employee",
    });

    // Archiving a non-admin, promoting someone, and reactivating are all in the
    // direction the guard does not care about — none may be blocked by it.
    expect((await users.setActiveGuarded(employee.id, false)).outcome).toBe("updated");
    expect((await users.setActiveGuarded(employee.id, true)).outcome).toBe("updated");
    expect((await users.setRoleGuarded(employee.id, "admin")).outcome).toBe("updated");
    // And the previously-only admin is now demotable, because there are two.
    expect((await users.setRoleGuarded(only.id, "employee")).outcome).toBe("updated");
  });

  // An already-archived admin is not part of the active set, so demoting one
  // must not be mistaken for removing the last active admin.
  it("does not count an archived admin as the last active one", async () => {
    const active = await createAdmin();
    const archived = await createAdmin();
    await users.setActiveGuarded(archived.id, false);

    expect((await users.setRoleGuarded(archived.id, "employee")).outcome).toBe("updated");
    expect((await users.setRoleGuarded(active.id, "employee")).outcome).toBe("last_admin");
  });
});
