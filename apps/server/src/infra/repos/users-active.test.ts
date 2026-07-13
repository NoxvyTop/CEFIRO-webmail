import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const users = createUsersRepo(sql);

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("users repo — active + admin ops", () => {
  it("new users are active and findByEmail returns active", async () => {
    const email = `a-${crypto.randomUUID()}@noxvytop.com`;
    const created = await users.create({ email, displayName: "A" });
    expect(created.active).toBe(true);
    expect((await users.findByEmail(email))?.active).toBe(true);
  });

  it("setActive archives and reactivates by id, null for missing", async () => {
    const user = await users.create({
      email: `b-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "B",
    });
    expect((await users.setActive(user.id, false))?.active).toBe(false);
    expect((await users.setActive(user.id, true))?.active).toBe(true);
    expect(await users.setActive(crypto.randomUUID(), false)).toBeNull();
  });

  it("setRole changes role by id, null for missing", async () => {
    const user = await users.create({
      email: `c-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "C",
    });
    expect((await users.setRole(user.id, "admin"))?.role).toBe("admin");
    expect(await users.setRole(crypto.randomUUID(), "admin")).toBeNull();
  });

  it("list returns users active-first", async () => {
    const all = await users.list();
    const firstInactiveIdx = all.findIndex((u) => !u.active);
    const lastActiveIdx = all.map((u) => u.active).lastIndexOf(true);
    if (firstInactiveIdx !== -1) expect(firstInactiveIdx).toBeGreaterThan(lastActiveIdx - 1);
    expect(Array.isArray(all)).toBe(true);
  });
});
