import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createSessionStore } from "./sessions";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const sessions = createSessionStore(sql);

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("revokeAllForUser", () => {
  it("deletes every session of the user and returns the count", async () => {
    const user = await createUsersRepo(sql).create({
      email: `r-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "R",
    });
    const a = await sessions.create(user.id, 1);
    const b = await sessions.create(user.id, 1);
    expect(await sessions.findUser(a.token)).not.toBeNull();

    const removed = await sessions.revokeAllForUser(user.id);
    expect(removed).toBe(2);
    expect(await sessions.findUser(a.token)).toBeNull();
    expect(await sessions.findUser(b.token)).toBeNull();
  });

  it("returns 0 when the user has no sessions", async () => {
    expect(await sessions.revokeAllForUser(crypto.randomUUID())).toBe(0);
  });
});
