import postgres from "postgres";

/**
 * Throwaway-database plumbing for the Playwright suite (GH #230).
 *
 * Before this, both playwright.config.ts and global-setup.ts fell back to
 * `postgres://webmail:webmail@localhost:5434/webmail` — the shared *development*
 * database — when DATABASE_URL was unset. The suite migrated it, wrote users,
 * sessions and encrypted mail credentials into it, never cleaned up, and
 * deliberately reused the same user row across runs. That is the same silent
 * fallback GH #181 removed from the server suite (see
 * apps/server/vitest.global-setup.ts, whose pattern this mirrors): it lets an
 * errant DATABASE_URL point a destructive suite at a real environment, and it
 * masks failures by carrying state between runs.
 *
 * So there is no fallback here either. DATABASE_URL must be set, and from it we
 * derive a uniquely named sibling database that the run creates, migrates,
 * seeds and drops. Nothing the suite writes can outlive the run, and nothing it
 * reads can have been left behind by a previous one.
 *
 * `postgres` is imported directly rather than through apps/server's `createDb`
 * wrapper: this module is loaded by playwright.config.ts at config-load time
 * (and by serve.ts under Bun), and it only ever issues CREATE/DROP DATABASE, so
 * the wrapper's DomainError mapping buys nothing and its import graph would be
 * pulled into config loading for no reason.
 */

/**
 * Carries the run's throwaway database URL from playwright.config.ts (which
 * mints it) to global-setup.ts and serve.ts (which create, seed and drop it).
 *
 * It doubles as an opt-in override: set it yourself and the suite uses that
 * database verbatim, creating and dropping nothing. That is the escape hatch
 * for the `E2E_BASE_URL` path, where an externally started server is already
 * bound to a database of the caller's choosing and a randomly named sibling
 * would be invisible to it.
 */
export const TEST_DATABASE_URL_ENV = "E2E_DATABASE_URL";

/**
 * Carries the *base* (admin) database URL into the webServer child process.
 * Playwright's `webServer.env` overrides DATABASE_URL there with the throwaway
 * URL, so serve.ts would otherwise have no connectable database to issue
 * CREATE DATABASE from.
 */
export const BASE_DATABASE_URL_ENV = "E2E_BASE_DATABASE_URL";

/**
 * The shape every database this module is allowed to create or drop must have.
 * Anchored and narrow on purpose: it cannot match `webmail`, `cefiro_dev`, or
 * anything else a human would name, so a misconfigured DATABASE_URL can never
 * turn `dropTestDatabase` into a destructive command against a real database.
 */
const THROWAWAY_DB_NAME = /^webmail_e2e_[0-9a-f]{16}$/;

/**
 * Reads DATABASE_URL, refusing to invent one. Mirrors the server suite's
 * fail-loudly contract (apps/server/vitest.global-setup.ts).
 */
export function requireBaseDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required to run the e2e suite. The suite creates a " +
        "throwaway database from it and never falls back to a shared or " +
        "development database. Point it at a disposable Postgres, e.g. " +
        "DATABASE_URL=postgres://webmail:webmail@localhost:5434/postgres\n" +
        `To drive an already-provisioned database instead, set ${TEST_DATABASE_URL_ENV} ` +
        "— the suite then uses it verbatim and creates/drops nothing.",
    );
  }
  return url;
}

/**
 * A Postgres identifier for the run's throwaway database: lowercase letters,
 * digits and underscores only, always starting with a letter, so it is a valid
 * unquoted identifier and cannot collide with a real database or a concurrent
 * run. Deliberately distinct from the server suite's `webmail_test_` prefix so
 * a leaked database says which suite leaked it.
 */
export function uniqueDbName(): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `webmail_e2e_${suffix}`;
}

/** Returns `base` with its database (path) swapped for `name`, everything else kept. */
export function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The database name a Postgres URL points at. */
export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/** Whether `url` names a database this module minted, and may therefore destroy. */
export function isThrowawayDatabase(url: string): boolean {
  return THROWAWAY_DB_NAME.test(databaseNameOf(url));
}

function assertThrowaway(url: string, action: string): string {
  const name = databaseNameOf(url);
  if (!THROWAWAY_DB_NAME.test(name)) {
    throw new Error(
      `refusing to ${action} database "${name}": only throwaway e2e databases ` +
        `(matching ${THROWAWAY_DB_NAME.source}) may be created or dropped by the suite.`,
    );
  }
  return name;
}

/**
 * Creates the run's throwaway database, if it does not exist yet.
 *
 * Idempotent because two entry points may reach it. Playwright starts
 * `webServer` as a plugin *before* globalSetup runs (see the runner's
 * createGlobalSetupTasks ordering), and apps/server/src/index.ts connects and
 * migrates on boot — so serve.ts has to create the database or the server
 * cannot start at all. When serve.ts is skipped (an externally supplied
 * E2E_BASE_URL, or `reuseExistingServer` finding a live server), global-setup.ts
 * is the one that creates it. Whichever runs first wins; the other no-ops.
 *
 * CREATE DATABASE cannot run inside a transaction block, so it goes through
 * `.unsafe()` (a simple query) on a single-connection admin pool bound to the
 * database named in DATABASE_URL. This only creates a sibling database; it never
 * writes to the base one.
 */
export async function createTestDatabase(baseUrl: string, testUrl: string): Promise<void> {
  const name = assertThrowaway(testUrl, "create");
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${name}`;
    if (existing.length === 0) {
      await admin.unsafe(`create database "${name}"`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Drops the run's throwaway database.
 *
 * WITH (FORCE) terminates any connection still open against it — Playwright
 * tears tasks down in reverse order, so globalSetup's teardown runs while the
 * `webServer` plugin's app server is still connected. Without FORCE the drop
 * would be blocked by that connection and the database would leak.
 */
export async function dropTestDatabase(baseUrl: string, testUrl: string): Promise<void> {
  const name = assertThrowaway(testUrl, "drop");
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}
