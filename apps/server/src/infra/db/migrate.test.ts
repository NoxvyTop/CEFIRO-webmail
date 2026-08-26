import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { testDatabaseUrl } from "./test-db";
import { MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID, migrate } from "./migrate";

const url = testDatabaseUrl();
const sql = createDb(url);
const dir = fileURLToPath(new URL("../../../migrations", import.meta.url));

afterAll(() => sql.end());

/**
 * A throwaway migration directory holding exactly one uniquely named
 * `create table`. Deliberately NOT `if not exists`: if two runners ever apply
 * it concurrently the second one must fail loudly, which is what makes the
 * concurrency assertions below meaningful rather than vacuous.
 */
async function singleMigrationDir(): Promise<{ dir: string; file: string; table: string }> {
  const table = `boot_race_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const created = await mkdtemp(join(tmpdir(), "migrate-lock-"));
  const file = `9999_${table}.sql`;
  await writeFile(join(created, file), `create table ${table} (id integer primary key);\n`);
  return { dir: created, file, table };
}

async function dropMigration(fixture: { dir: string; file: string; table: string }): Promise<void> {
  await sql.unsafe(`drop table if exists ${fixture.table}`);
  await sql`delete from schema_migrations where name = ${fixture.file}`;
  await rm(fixture.dir, { recursive: true, force: true });
}

async function appliedCount(file: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from schema_migrations where name = ${file}
  `;
  return rows[0]?.n ?? 0;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await sql`
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = ${table}
  `;
  return rows.length > 0;
}

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
      // GH #314: Tier A ("known sender") store — addresses the user has
      // written to, kept apart from `contacts` on purpose.
      "sent_recipients",
      // GH #313: automatic shared-mailbox copies — the per-account Email state
      // cursor (with its delivery lease), the per-member baseline and the
      // per-member dedup ledger.
      "shared_mailbox_copy_state",
      "shared_mailbox_member_state",
      "shared_mailbox_copies",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

// GH #207. Two replicas booting at the same time each run migrate() against the
// same database. Each `createDb` here is a separate pool — a separate replica —
// so these exercise the real cross-connection race, not two calls sharing one
// connection.
describe("migrate under concurrent boots", () => {
  it("applies a pending migration exactly once when two replicas boot together", async () => {
    const fixture = await singleMigrationDir();
    const replicaA = createDb(url, { poolMax: 1 });
    const replicaB = createDb(url, { poolMax: 1 });
    try {
      // Without the advisory lock both replicas pass the `select 1` check and
      // the loser dies on the DDL or on the primary-key insert; neither may
      // reject here.
      await Promise.all([migrate(replicaA, fixture.dir), migrate(replicaB, fixture.dir)]);

      expect(await appliedCount(fixture.file)).toBe(1);
      expect(await tableExists(fixture.table)).toBe(true);
    } finally {
      await replicaA.end();
      await replicaB.end();
      await dropMigration(fixture);
    }
  });

  it("waits while another replica holds the migration lock", async () => {
    const fixture = await singleMigrationDir();
    const holder = createDb(url, { poolMax: 1 });
    const waiter = createDb(url, { poolMax: 1 });
    let releaseHolder: () => void = () => {};
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderHasLock: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    // Takes the same lock the runner takes and parks, standing in for a replica
    // that is midway through a slow migration.
    const holding = holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_CLASS}::int, ${MIGRATION_LOCK_ID}::int)`;
      holderHasLock();
      await holderReleased;
    });
    // Started only once the holder demonstrably owns the lock. Without this the
    // two race for it, and on a busy machine the "waiter" could win, take the
    // lock, apply the migration and settle — failing the assertion below for a
    // reason that has nothing to do with the behaviour under test. Serial
    // execution hid it; GH #14's parallelism did not.
    await lockTaken;
    let settled = false;
    const running = migrate(waiter, fixture.dir).then(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled).toBe(false);
      expect(await appliedCount(fixture.file)).toBe(0);
    } finally {
      releaseHolder();
      await holding;
      await running;
      await holder.end();
      await waiter.end();
    }

    expect(settled).toBe(true);
    expect(await appliedCount(fixture.file)).toBe(1);
    expect(await tableExists(fixture.table)).toBe(true);
    await dropMigration(fixture);
  });
});
