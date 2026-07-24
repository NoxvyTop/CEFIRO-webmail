import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { migrate } from "../db/migrate";
import { createInstanceSettingsRepo } from "./instance-settings";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("instance settings repo", () => {
  it("defaults to the footer disabled when no row exists, and round-trips through set()", async () => {
    // instance_settings is a singleton row (id = 1) shared with other suites
    // (admin instance tests) against the same persistent database. Delete it
    // so "before any config" reflects a deterministic no-row state — mirrors
    // sso-config.test.ts / admin-sso.test.ts's handling of sso_config.
    await sql`delete from instance_settings where id = 1`;

    const repo = createInstanceSettingsRepo(sql);
    expect((await repo.get()).sentWithFooterEnabled).toBe(false);

    await repo.set({ sentWithFooterEnabled: true });
    expect((await repo.get()).sentWithFooterEnabled).toBe(true);

    await repo.set({ sentWithFooterEnabled: false });
    expect((await repo.get()).sentWithFooterEnabled).toBe(false);
  });
});
