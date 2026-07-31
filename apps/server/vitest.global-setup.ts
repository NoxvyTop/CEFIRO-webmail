import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";
import { createDb } from "./src/infra/db/client";
import { migrate } from "./src/infra/db/migrate";

// The URL of the throwaway database is handed to the test workers through
// Vitest's provide/inject channel. The ProvidedContext augmentation that types
// the "databaseUrl" key lives in src/infra/db/test-db.ts (the reader), because
// tsconfig only typechecks `src`.

/**
 * A Postgres identifier for the run's throwaway database. Only lowercase
 * letters, digits and underscores, and it always starts with a letter, so it is
 * a valid unquoted identifier and can never collide with a real database
 * (`webmail`, `cefiro_dev`, …) or with a concurrent run.
 */
function uniqueDbName(): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `webmail_test_${suffix}`;
}

/** Returns `base` with its database (path) swapped for `name`, everything else kept. */
function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Provisions an isolated, throwaway Postgres database for the whole server test
 * run and drops it afterwards (GH #181).
 *
 * Before this, every test file fell back to
 * `postgres://webmail:webmail@localhost:5434/webmail` when DATABASE_URL was
 * unset — the shared *development* database. The suite wrote encrypted
 * credentials and thousands of generated users straight into it and never
 * cleaned up, which eventually left the dev server unable to boot. Worse, the
 * silent fallback meant an errant DATABASE_URL in a terminal could point the
 * suite at a real environment.
 *
 * So there is no fallback: DATABASE_URL must be set (CI already sets it to its
 * fresh `postgres` service database). From it we create a uniquely named
 * sibling database, migrate it once, and point the whole suite at it via
 * provide/inject. Dropping it at the end makes the suite self-cleaning by
 * construction — nothing it writes can outlive the run.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      "DATABASE_URL is required to run the server test suite. The suite creates " +
        "a throwaway database from it and never falls back to a shared or " +
        "development database. Point it at a disposable Postgres, e.g. " +
        "DATABASE_URL=postgres://webmail:webmail@localhost:5434/postgres",
    );
  }

  const dbName = uniqueDbName();
  const testUrl = withDatabase(baseUrl, dbName);

  // CREATE DATABASE cannot run inside a transaction block, so it goes through
  // .unsafe() (a simple query) on a single-connection admin pool bound to the
  // database named in DATABASE_URL. This only creates a sibling database; it
  // never writes to the base one.
  const admin = createDb(baseUrl, { poolMax: 1 });
  try {
    await admin.unsafe(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  // Migrate the fresh database once here so every test file finds a ready
  // schema whether or not it runs migrate() itself.
  const migrated = createDb(testUrl, { poolMax: 1 });
  try {
    await migrate(migrated, fileURLToPath(new URL("./migrations", import.meta.url)));
  } finally {
    await migrated.end();
  }

  provide("databaseUrl", testUrl);

  return async () => {
    // WITH (FORCE) terminates any connection a test left open (postgres 17, the
    // image used locally and in CI) so the drop cannot be blocked by a leak.
    const cleanup = createDb(baseUrl, { poolMax: 1 });
    try {
      await cleanup.unsafe(`drop database if exists "${dbName}" with (force)`);
    } finally {
      await cleanup.end();
    }
  };
}
