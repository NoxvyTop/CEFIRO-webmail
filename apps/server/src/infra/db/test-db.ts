import { inject } from "vitest";

// The throwaway database URL vitest.global-setup.ts provisions per run and hands
// to the workers via provide/inject. Declared here (not in the global-setup
// file) because tsconfig only typechecks `src`, so this is the augmentation the
// rest of the suite actually sees.
declare module "vitest" {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * URL of the throwaway Postgres database this test run uses. It is created and
 * dropped per run by vitest.global-setup.ts, which hands the URL to the workers
 * via provide/inject.
 *
 * There is deliberately no fallback to a shared or development database (GH
 * #181): a test process that cannot find its isolated database must fail loudly
 * rather than silently write into a real one. globalSetup already refuses to
 * start without DATABASE_URL, so this only ever returns a disposable database.
 */
export function testDatabaseUrl(): string {
  const url = inject("databaseUrl");
  if (!url) {
    throw new Error(
      "No test database URL was provided. The server test suite must run under " +
        "Vitest with vitest.global-setup.ts, which provisions a throwaway " +
        "database and provides its URL.",
    );
  }
  return url;
}
