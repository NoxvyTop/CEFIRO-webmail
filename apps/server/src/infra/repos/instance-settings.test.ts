import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createInstanceSettingsRepo } from "./instance-settings";

const sql = createDb(testDatabaseUrl());

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

  // GH #347: GET /api/instance is public and unauthenticated, so every hit
  // used to be a per-request Postgres read. Same in-process cache pattern as
  // sso-config.ts's providerNameCache — a fake sql counts the SELECTs to
  // prove the second get() is served from cache and set() invalidates it.
  it("caches get() in-process and invalidates it on set", async () => {
    let reads = 0;
    const fakeSql = ((strings: TemplateStringsArray) => {
      if (strings.join(" ").includes("select sent_with_footer_enabled")) {
        reads += 1;
        return Promise.resolve([{ sent_with_footer_enabled: true }]);
      }
      return Promise.resolve([]);
    }) as unknown as Db;
    const repo = createInstanceSettingsRepo(fakeSql);

    expect((await repo.get()).sentWithFooterEnabled).toBe(true);
    expect((await repo.get()).sentWithFooterEnabled).toBe(true);
    expect(reads).toBe(1); // second read served from cache

    await repo.set({ sentWithFooterEnabled: false });
    // set() invalidated the cache, so the read below hits Postgres again...
    expect((await repo.get()).sentWithFooterEnabled).toBe(true);
    expect(reads).toBe(2);
  });
});
