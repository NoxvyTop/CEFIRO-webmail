import { afterEach, expect, test } from "bun:test";
import {
  TEST_DATABASE_URL_ENV,
  createTestDatabase,
  databaseNameOf,
  dropTestDatabase,
  isThrowawayDatabase,
  requireBaseDatabaseUrl,
  uniqueDbName,
  withDatabase,
} from "./test-db";

// GH #247. This module is the harness's blast radius: it is the only thing
// standing between an errant DATABASE_URL and `DROP DATABASE` against a real
// one, and it is also what makes every run start from an empty database rather
// than from whatever the previous run left behind. Neither property is checked
// by the Playwright suite — a broken guard produces a run that is green right
// up until the moment it destroys something — so both are pinned here, where
// they cost no Postgres and no browser.

const BASE = "postgres://webmail:webmail@localhost:5434/postgres";

// requireBaseDatabaseUrl reads the ambient DATABASE_URL, which CI sets for the
// whole `bun run test` fan-out. Restore whatever it was after each test rather
// than assuming it is absent.
const originalDatabaseUrl = process.env.DATABASE_URL;
afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("uniqueDbName produces a valid, unquoted Postgres identifier", () => {
  const name = uniqueDbName();
  // Starts with a letter and holds only [a-z0-9_], so it never needs quoting
  // and can never be read as anything but an identifier.
  expect(name).toMatch(/^webmail_e2e_[0-9a-f]{16}$/);
});

test("uniqueDbName does not repeat across runs", () => {
  // Two concurrent runs sharing a database name would migrate and drop each
  // other's data — the exact cross-run bleed GH #230 removed.
  const names = new Set(Array.from({ length: 50 }, () => uniqueDbName()));
  expect(names.size).toBe(50);
});

test("withDatabase swaps only the database, keeping credentials, host and port", () => {
  const url = new URL(withDatabase(BASE, "webmail_e2e_0123456789abcdef"));
  expect(url.pathname).toBe("/webmail_e2e_0123456789abcdef");
  expect(url.username).toBe("webmail");
  expect(url.password).toBe("webmail");
  expect(url.host).toBe("localhost:5434");
});

test("withDatabase preserves connection parameters carried in the query string", () => {
  // sslmode and friends live in the query string; dropping them here would
  // point the suite's server at a database it cannot connect to, with an error
  // that names TLS rather than this function.
  const swapped = withDatabase(`${BASE}?sslmode=require`, "webmail_e2e_0123456789abcdef");
  expect(new URL(swapped).searchParams.get("sslmode")).toBe("require");
});

test("databaseNameOf reads the database out of a connection URL", () => {
  expect(databaseNameOf(BASE)).toBe("postgres");
  expect(databaseNameOf(withDatabase(BASE, "webmail_e2e_0123456789abcdef"))).toBe(
    "webmail_e2e_0123456789abcdef",
  );
});

test("isThrowawayDatabase recognizes a name this module minted", () => {
  expect(isThrowawayDatabase(withDatabase(BASE, uniqueDbName()))).toBe(true);
});

test("isThrowawayDatabase refuses every database a human would name", () => {
  // The three that actually exist on a developer's machine and on CI, plus the
  // server suite's own prefix — this module must never touch that one either.
  for (const name of ["webmail", "cefiro_dev", "postgres", "webmail_test_0123456789abcdef"]) {
    expect(isThrowawayDatabase(withDatabase(BASE, name))).toBe(false);
  }
});

test("isThrowawayDatabase is anchored, so a real name cannot be smuggled past it", () => {
  // Unanchored, every one of these would match somewhere and be destroyable.
  for (const name of [
    "webmail_e2e_0123456789abcdef_keepme",
    "prod_webmail_e2e_0123456789abcdef",
    "webmail_e2e_0123456789abcdeff",
    "webmail_e2e_0123456789abcde",
    "webmail_e2e_0123456789ABCDEF",
  ]) {
    expect(isThrowawayDatabase(withDatabase(BASE, name))).toBe(false);
  }
});

test("dropTestDatabase refuses a database it did not mint, before connecting", async () => {
  // The assertion runs ahead of the admin connection, so this rejects without
  // Postgres being reachable at all — which is also why it is testable here.
  await expect(dropTestDatabase(BASE, withDatabase(BASE, "webmail"))).rejects.toThrow(
    /refusing to drop database "webmail"/,
  );
});

test("createTestDatabase refuses a database it did not mint, before connecting", async () => {
  await expect(createTestDatabase(BASE, withDatabase(BASE, "cefiro_dev"))).rejects.toThrow(
    /refusing to create database "cefiro_dev"/,
  );
});

test("requireBaseDatabaseUrl returns DATABASE_URL when it is set", () => {
  process.env.DATABASE_URL = BASE;
  expect(requireBaseDatabaseUrl()).toBe(BASE);
});

test("requireBaseDatabaseUrl throws instead of inventing a fallback", () => {
  delete process.env.DATABASE_URL;
  // The whole point of GH #230: the silent default WAS the shared development
  // database. The error also has to name the escape hatch, or the first person
  // to hit it re-adds the fallback.
  expect(() => requireBaseDatabaseUrl()).toThrow(/DATABASE_URL is required/);
  expect(() => requireBaseDatabaseUrl()).toThrow(new RegExp(TEST_DATABASE_URL_ENV));
});
