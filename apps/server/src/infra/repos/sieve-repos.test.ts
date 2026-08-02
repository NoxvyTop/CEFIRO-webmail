import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createFilterRulesRepo } from "./filter-rules";
import { createSieveRawScriptRepo } from "./sieve-raw-script";
import { createVacationSettingsRepo } from "./vacation-settings";

const sql = createDb(testDatabaseUrl());

let userId: string;
let otherUserId: string;
const filterRules = createFilterRulesRepo(sql);
const vacationSettings = createVacationSettingsRepo(sql);
const sieveRawScript = createSieveRawScriptRepo(sql);

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
    expect(await filterRules.reorder(userId, [reversed[0]!, reversed[0]!])).toBe(false);
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

// GH #23: the repo the advanced mode rests on. The property that matters is
// asymmetry — saving takes ownership and replaces the text, handing back only
// flips the mode — because it is what makes a mode switch unable to lose work.
describe("sieve raw script repo", () => {
  const script = 'require ["fileinto"];\nfileinto "Ops";\n';

  it("reports rule-builder mode with nothing stored when no row exists", async () => {
    expect(await sieveRawScript.get(otherUserId)).toEqual({
      mode: "rules",
      script: "",
      updatedAt: null,
    });
  });

  it("takes ownership as part of saving, with no separate activation step", async () => {
    const saved = await sieveRawScript.save(userId, script);
    expect(saved.mode).toBe("raw");
    expect(saved.script).toBe(script);
    expect(saved.updatedAt).not.toBeNull();
    expect(await sieveRawScript.get(userId)).toMatchObject({ mode: "raw", script });
  });

  it("keeps the script when ownership is handed back to the rule builder", async () => {
    const handedBack = await sieveRawScript.handBackToRules(userId);
    expect(handedBack.mode).toBe("rules");
    // Deactivated, never deleted: the user must find their script unchanged.
    expect(handedBack.script).toBe(script);
    expect(await sieveRawScript.get(userId)).toMatchObject({ mode: "rules", script });
  });

  it("re-activates the same text without needing it sent again", async () => {
    const again = await sieveRawScript.save(userId, script);
    expect(again).toMatchObject({ mode: "raw", script });
  });

  it("keeps each user's script to themselves", async () => {
    await sieveRawScript.handBackToRules(otherUserId);
    expect(await sieveRawScript.get(otherUserId)).toMatchObject({ mode: "rules", script: "" });
    expect(await sieveRawScript.get(userId)).toMatchObject({ mode: "raw", script });
  });
});
