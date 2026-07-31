import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { testDatabaseUrl } from "./test-db";
import { migrate } from "./migrate";

const sql = createDb(testDatabaseUrl());
const dir = fileURLToPath(new URL("../../../migrations", import.meta.url));

afterAll(() => sql.end());

describe("migrate", () => {
  it("creates the full F1 schema and is idempotent", async () => {
    await migrate(sql, dir);
    await migrate(sql, dir); // second run must be a no-op

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `;
    const names = tables.map((t) => t.table_name);
    for (const expected of [
      "users",
      "mail_credentials",
      "signatures",
      "user_preferences",
      "sessions",
      "audit_log",
      "sso_config",
      "integrations",
      "schema_migrations",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
