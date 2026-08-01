import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./client";

// Advisory-lock key for the migration runner (GH #207).
//
// Every replica runs migrate() at boot (src/index.ts), and without a lock the
// runner was a check-then-insert race: two replicas starting together both
// passed `select 1 from schema_migrations`, both executed the same DDL, and the
// loser died — either on the DDL itself or on the primary-key insert that
// follows it. That is a crash loop, not a transient error, because every
// restart re-runs the same race. Holding a lock around the whole runner makes
// it mutually exclusive across replicas: one migrates, the others wait and then
// find every migration already applied.
//
// Postgres advisory locks share a single 64-bit key space per database, so the
// key is a fixed application-specific constant rather than something derived
// from the schema. The two-int form keeps both halves int4-sized (no bigint
// serialization on the wire); the class is an arbitrary marker and the id is
// this issue's number, which is what makes the pair greppable.
export const MIGRATION_LOCK_CLASS = 0x6365; // "ce" — CEFIRO webmail
export const MIGRATION_LOCK_ID = 207;

export async function migrate(sql: Db, dir: string): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  // The whole run — the bookkeeping table included — happens inside one
  // transaction that holds the advisory lock.
  //
  // `pg_advisory_xact_lock` rather than the session-scoped `pg_advisory_lock`
  // because it is released on commit AND on rollback, so a replica killed
  // mid-migration cannot leave the lock held and wedge every other replica.
  // It also keeps the runner on a single pooled connection, which matters:
  // callers legitimately open the pool with `poolMax: 1`
  // (vitest.global-setup.ts, scripts/migrate.ts), and a design that took the
  // lock on one connection while migrating on another would deadlock there.
  //
  // Creating `schema_migrations` moved inside the lock as well: two concurrent
  // `create table if not exists` for the same name race in the system catalogs
  // and one of them fails with a duplicate-key error on pg_type_typname_index,
  // which is the same boot crash one step earlier.
  await sql.begin(async (tx) => {
    // Waiting for another replica to finish migrating is not a slow query, and
    // neither is a legitimately long DDL step. The pool's 30s statement_timeout
    // (infra/db/client.ts) would abort both, turning the wait this lock exists
    // to create straight back into the crash loop it replaces. `set local`
    // scopes the exemption to this transaction, so the connection returns to
    // the pool with its normal cap.
    await tx.unsafe("set local statement_timeout = 0");
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_CLASS}::int, ${MIGRATION_LOCK_ID}::int)`;
    await tx`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    for (const file of files) {
      const applied = await tx`select 1 from schema_migrations where name = ${file}`;
      if (applied.length > 0) continue;
      const body = await readFile(join(dir, file), "utf8");
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    }
  });
}
