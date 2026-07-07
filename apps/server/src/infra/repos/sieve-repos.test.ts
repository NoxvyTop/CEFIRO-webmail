import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createFilterRulesRepo } from "./filter-rules";
import { createVacationSettingsRepo } from "./vacation-settings";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let userId: string;
let otherUserId: string;
const filterRules = createFilterRulesRepo(sql);
const vacationSettings = createVacationSettingsRepo(sql);

const input = {
  name: "invoices",
  matchType: "all" as const,
  conditions: [{ field: "from" as const, op: "contains" as const, value: "billing@" }],
  actions: [{ type: "fileinto" as const, folder: "Invoices" }],
  enabled: true,
};

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const user1 = await users.create({
    email: `sieve1-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve User 1",
  });
  userId = user1.id;
  const user2 = await users.create({
    email: `sieve2-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve User 2",
  });
  otherUserId = user2.id;
});
afterAll(() => sql.end());

describe("filter rules repo", () => {
  it("creates rules with incrementing positions and lists in order", async () => {
    const first = await filterRules.create(userId, input);
    const second = await filterRules.create(userId, { ...input, name: "newsletters" });
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
    expect(first.conditions).toEqual(input.conditions);
    expect(first.actions).toEqual(input.actions);
    const list = await filterRules.list(userId);
    expect(list.map((r) => r.name)).toEqual(["invoices", "newsletters"]);
  });

  it("updates only own rules", async () => {
    const list = await filterRules.list(userId);
    const target = list[0]!;
    const updated = await filterRules.update(userId, target.id, { ...input, name: "renamed" });
    expect(updated?.name).toBe("renamed");
    const foreign = await filterRules.update(otherUserId, target.id, input);
    expect(foreign).toBeNull();
  });

  it("reorders with a complete id set and rejects partial or foreign sets", async () => {
    const list = await filterRules.list(userId);
    const reversed = [...list].reverse().map((r) => r.id);
    expect(await filterRules.reorder(userId, reversed)).toBe(true);
    const after = await filterRules.list(userId);
    expect(after.map((r) => r.id)).toEqual(reversed);
    expect(await filterRules.reorder(userId, [reversed[0]!])).toBe(false);
    expect(await filterRules.reorder(otherUserId, reversed)).toBe(false);
  });

  it("removes only own rules", async () => {
    const created = await filterRules.create(userId, { ...input, name: "temp" });
    expect(await filterRules.remove(otherUserId, created.id)).toBe(false);
    expect(await filterRules.remove(userId, created.id)).toBe(true);
  });
});

describe("vacation settings repo", () => {
  it("returns defaults when no row exists", async () => {
    const settings = await vacationSettings.get(userId);
    expect(settings).toEqual({
      enabled: false,
      subject: "",
      message: "",
      startsAt: null,
      endsAt: null,
      intervalDays: 7,
    });
  });

  it("upserts and returns date-only strings", async () => {
    const saved = await vacationSettings.set(userId, {
      enabled: true,
      subject: "Out",
      message: "Away until the 20th",
      startsAt: "2026-07-10",
      endsAt: "2026-07-20",
      intervalDays: 3,
    });
    expect(saved.startsAt).toBe("2026-07-10");
    expect(saved.endsAt).toBe("2026-07-20");
    const again = await vacationSettings.set(userId, {
      enabled: false,
      subject: "",
      message: "",
      startsAt: null,
      endsAt: null,
      intervalDays: 7,
    });
    expect(again.enabled).toBe(false);
    expect(again.startsAt).toBeNull();
  });
});
