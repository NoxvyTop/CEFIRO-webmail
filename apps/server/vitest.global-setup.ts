import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";
import { createDb } from "./src/infra/db/client";
import { migrate } from "./src/infra/db/migrate";
import { TEST_WORKER_COUNT } from "./vitest.workers";

// The URLs of the throwaway databases are handed to the test workers through
// Vitest's provide/inject channel. The ProvidedContext augmentation that types
// the "databaseUrls" key lives in src/infra/db/test-db.ts (the reader), because
// tsconfig only typechecks `src`.

/**
 * A Postgres identifier for the run's throwaway databases. Only lowercase
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
 * Provisions isolated, throwaway Postgres databases for the server test run and
 * drops them afterwards (GH #181, then GH #14).
 *
 * Before #181, every test file fell back to
 * `postgres://webmail:webmail@localhost:5434/webmail` when DATABASE_URL was
 * unset — the shared *development* database. The suite wrote encrypted
 * credentials and thousands of generated users straight into it and never
 * cleaned up, which eventually left the dev server unable to boot. Worse, the
 * silent fallback meant an errant DATABASE_URL in a terminal could point the
 * suite at a real environment.
 *
 * So there is no fallback: DATABASE_URL must be set (CI already sets it to its
 * fresh `postgres` service database). From it we create uniquely named sibling
 * databases and point the suite at them via provide/inject. Dropping them at
 * the end makes the suite self-cleaning by construction — nothing it writes can
 * outlive the run.
 *
 * GH #14 turned the one database into one PER WORKER SLOT. A single shared
 * database is what forced `fileParallelism: false`: files running side by side
 * fought over the `sso_config` singleton row, over aggregate user counts, and
 * over the database-wide advisory lock the migration takes. Each slot now owns
 * its own database, so concurrency no longer means sharing — see
 * src/infra/db/test-db.ts for how a worker finds its own.
 *
 * They are minted with `TEMPLATE`, not migrated one by one: the schema is
 * applied once to the base database and each slot's copy is a file copy of it,
 * so raising TEST_WORKER_COUNT costs a copy rather than another migration run.
 */
export default async function setup(context: GlobalSetupContext): Promise<() => Promise<void>> {
  const { provide } = context;
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      "DATABASE_URL is required to run the server test suite. The suite creates " +
        "throwaway databases from it and never falls back to a shared or " +
        "development database. Point it at a disposable Postgres, e.g. " +
        "DATABASE_URL=postgres://webmail:webmail@localhost:5434/postgres",
    );
  }

  // One database per worker slot, so `maxWorkers` and this count are the same
  // number by construction. vitest.config.ts sets maxWorkers from the same
  // constant; a worker whose slot has no database refuses to run rather than
  // borrowing another one's (see testDatabaseUrl).
  const configured = Number(context.config?.maxWorkers ?? TEST_WORKER_COUNT);
  const workerCount = Number.isInteger(configured) && configured > 0 ? configured : TEST_WORKER_COUNT;

  const templateName = uniqueDbName();
  const templateUrl = withDatabase(baseUrl, templateName);
  const workerNames = Array.from({ length: workerCount }, (_, i) => `${templateName}_w${i + 1}`);

  // CREATE DATABASE cannot run inside a transaction block, so it goes through
  // .unsafe() (a simple query) on a single-connection admin pool bound to the
  // database named in DATABASE_URL. This only creates sibling databases; it
  // never writes to the base one.
  const admin = createDb(baseUrl, { poolMax: 1 });
  try {
    await admin.unsafe(`create database "${templateName}"`);
  } finally {
    await admin.end();
  }

  // Migrate the template once, then copy it. Every worker's database therefore
  // finds a ready schema whether or not its test files run migrate() themselves.
  const migrated = createDb(templateUrl, { poolMax: 1 });
  try {
    await migrate(migrated, fileURLToPath(new URL("./migrations", import.meta.url)));
  } finally {
    // Closed before the copies below: Postgres refuses to use a template that
    // any other session is connected to.
    await migrated.end();
  }

  const copier = createDb(baseUrl, { poolMax: 1 });
  try {
    // Sequential on purpose. Two concurrent copies of the same template are a
    // race this has no reason to run, and the whole loop is a handful of file
    // copies of an empty schema.
    for (const name of workerNames) {
      await copier.unsafe(`create database "${name}" template "${templateName}"`);
    }
  } finally {
    await copier.end();
  }

  provide(
    "databaseUrls",
    workerNames.map((name) => withDatabase(baseUrl, name)),
  );

  return async () => {
    // WITH (FORCE) terminates any connection a test left open (postgres 17, the
    // image used locally and in CI) so a drop cannot be blocked by a leak.
    const cleanup = createDb(baseUrl, { poolMax: 1 });
    try {
      for (const name of [...workerNames, templateName]) {
        await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      }
    } finally {
      await cleanup.end();
    }
  };
}
