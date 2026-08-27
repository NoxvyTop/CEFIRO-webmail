import { inject } from "vitest";

// The throwaway database URLs vitest.global-setup.ts provisions per run — one
// per worker slot — and hands to the workers via provide/inject. Declared here
// (not in the global-setup file) because tsconfig only typechecks `src`, so
// this is the augmentation the rest of the suite actually sees.
declare module "vitest" {
  interface ProvidedContext {
    databaseUrls: string[];
  }
}

/**
 * URL of the throwaway Postgres database THIS worker owns. Created and dropped
 * per run by vitest.global-setup.ts, which hands every slot's URL to the
 * workers via provide/inject.
 *
 * One database per worker SLOT rather than one per run (GH #14). The suite is
 * full of state that a single shared database makes global: the `sso_config`
 * singleton (id = 1), which concurrent files each wrote a different encrypted
 * client secret into until one of them could no longer decrypt its own; the
 * aggregate user counts admin-users.test.ts asserts a delta on, which a file
 * creating users next door moves underneath it; and the database-wide advisory
 * lock migrate.test.ts holds. All of that was serialized away with
 * `fileParallelism: false`, which spent the whole suite's parallelism to fix a
 * sharing problem — this removes the sharing instead.
 *
 * Vitest runs at most one file per worker slot at a time, so no two files that
 * run CONCURRENTLY can see the same database. Files that reuse a slot in
 * sequence still share one, exactly as every file already shared one before —
 * that case is unchanged, and the suite already tolerates it.
 *
 * There is deliberately no fallback to a shared or development database (GH
 * #181): a test process that cannot find its isolated database must fail loudly
 * rather than silently write into a real one. globalSetup already refuses to
 * start without DATABASE_URL, so this only ever returns a disposable database.
 */
export function testDatabaseUrl(): string {
  const urls = inject("databaseUrls");
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(
      "No test database URLs were provided. The server test suite must run under " +
        "Vitest with vitest.global-setup.ts, which provisions a throwaway " +
        "database per worker slot and provides their URLs.",
    );
  }
  // Set by vitest in every worker (dist/worker.js): 1-based, and bounded by the
  // configured maxWorkers — which is exactly how many databases were minted.
  const slot = Number(process.env.VITEST_POOL_ID ?? "1");
  const url = Number.isInteger(slot) && slot >= 1 ? urls[slot - 1] : undefined;
  if (!url) {
    throw new Error(
      `Worker slot ${process.env.VITEST_POOL_ID} has no throwaway database of its own: ` +
        `this run provisioned ${urls.length}. vitest.config.ts's maxWorkers is what ` +
        "vitest.global-setup.ts provisions for, so the two cannot drift apart — and " +
        "quietly borrowing another slot's database would reintroduce GH #14.",
    );
  }
  return url;
}
