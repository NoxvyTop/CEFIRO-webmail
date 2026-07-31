import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../core/errors";
import {
  buildDbOptions,
  DEFAULT_DB_CONNECT_TIMEOUT_S,
  DEFAULT_DB_IDLE_TIMEOUT_S,
  DEFAULT_DB_POOL_MAX,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  isConnectionError,
  mapDbError,
  wrapDbErrors,
} from "./client";

// A transport/connection failure carries a postgres.js connection code or a
// Node socket errno; a server-side query error carries a 5-char SQLSTATE.
function connErr(code: string): Error {
  return Object.assign(new Error(`transport ${code}`), { code });
}
function queryErr(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

/**
 * Fake postgres client: a tagged-template call rejects with `err`; any other
 * call shape is a query fragment and returns a sentinel (never a promise).
 */
function fakeSql(err: unknown): any {
  return (strings: unknown, ..._args: unknown[]) => {
    const isTemplate =
      Array.isArray(strings) && Array.isArray((strings as { raw?: unknown }).raw);
    return isTemplate ? Promise.reject(err) : { fragment: true };
  };
}

describe("buildDbOptions (GH #191 — bounded pool + timeouts)", () => {
  it("applies bounded defaults to every postgres timeout and the pool", () => {
    const options = buildDbOptions();
    expect(options.max).toBe(DEFAULT_DB_POOL_MAX);
    expect(options.connect_timeout).toBe(DEFAULT_DB_CONNECT_TIMEOUT_S);
    expect(options.idle_timeout).toBe(DEFAULT_DB_IDLE_TIMEOUT_S);
    // statement_timeout is a server GUC, so it rides under `connection`.
    expect(options.connection).toEqual({
      statement_timeout: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    });
  });

  it("keeps every default a positive number so no query can hang the pool forever", () => {
    expect(DEFAULT_DB_POOL_MAX).toBeGreaterThan(0);
    expect(DEFAULT_DB_CONNECT_TIMEOUT_S).toBeGreaterThan(0);
    expect(DEFAULT_DB_IDLE_TIMEOUT_S).toBeGreaterThan(0);
    expect(DEFAULT_DB_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("lets each limit be overridden", () => {
    const options = buildDbOptions({
      poolMax: 5,
      connectTimeoutS: 3,
      idleTimeoutS: 60,
      statementTimeoutMs: 5_000,
    });
    expect(options.max).toBe(5);
    expect(options.connect_timeout).toBe(3);
    expect(options.idle_timeout).toBe(60);
    expect(options.connection).toEqual({ statement_timeout: 5_000 });
  });
});

describe("mapDbError (GH #191 — DB transport failure → 503)", () => {
  it.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "CONNECT_TIMEOUT",
    "CONNECTION_CLOSED",
    "CONNECTION_ENDED",
    "CONNECTION_DESTROYED",
  ])("maps transport error %s to a 503 database_unavailable DomainError", (code) => {
    const mapped = mapDbError(connErr(code));
    expect(mapped).toBeInstanceOf(DomainError);
    expect(mapped).toMatchObject({
      code: "database_unavailable",
      httpStatus: 503,
      messageKey: "errors.database_unavailable",
    });
    expect(isConnectionError(connErr(code))).toBe(true);
  });

  it.each(["23505", "23503", "42P01", "57014"])(
    "leaves the server-side query error %s untouched (a constraint violation or a statement_timeout cancel is NOT 'database unavailable')",
    (code) => {
      const original = queryErr(code);
      expect(mapDbError(original)).toBe(original);
      expect(isConnectionError(original)).toBe(false);
    },
  );

  it("passes a client usage error (no transport code) through unchanged, staying a 500-bucket bug", () => {
    const usage = Object.assign(new Error("not tagged"), { code: "NOT_TAGGED_CALL" });
    expect(mapDbError(usage)).toBe(usage);
    const codeless = new Error("boom");
    expect(mapDbError(codeless)).toBe(codeless);
  });

  it("does not double-wrap an existing DomainError", () => {
    const already = new DomainError("upstream_timeout", 504, "errors.upstream_timeout");
    expect(mapDbError(already)).toBe(already);
  });
});

describe("wrapDbErrors (GH #191 — every repo inherits the mapping)", () => {
  it("maps a connection failure on a query to database_unavailable (503)", async () => {
    const sql = wrapDbErrors(fakeSql(connErr("ECONNREFUSED")));
    await expect(sql`select 1`).rejects.toMatchObject({
      code: "database_unavailable",
      httpStatus: 503,
    });
  });

  it("leaves an ordinary query error (constraint violation) unchanged", async () => {
    const sql = wrapDbErrors(fakeSql(queryErr("23505")));
    await expect(sql`insert into t values (1)`).rejects.toMatchObject({ code: "23505" });
    await expect(sql`insert into t values (1)`).rejects.not.toBeInstanceOf(DomainError);
  });

  it("returns query fragments (sql(rows), sql.json) untouched — never awaited/mapped", () => {
    const sql = wrapDbErrors(fakeSql(connErr("ECONNREFUSED")));
    // A non-template call: postgres would build a Builder/Identifier fragment.
    expect((sql as any)([{ a: 1 }])).toMatchObject({ fragment: true });
  });

  it("passes a successful query result through unchanged", async () => {
    const rows = [{ id: 1 }];
    const base: any = (strings: unknown) =>
      Array.isArray(strings) && Array.isArray((strings as any).raw)
        ? Promise.resolve(rows)
        : { fragment: true };
    const sql = wrapDbErrors(base);
    await expect(sql`select 1`).resolves.toBe(rows);
  });

  it("maps a connection failure inside a transaction (sql.begin) to 503", async () => {
    const base: any = fakeSql(queryErr("23505"));
    base.begin = () => Promise.reject(connErr("CONNECTION_CLOSED"));
    const sql = wrapDbErrors(base);
    await expect(sql.begin(async () => {})).rejects.toMatchObject({
      code: "database_unavailable",
      httpStatus: 503,
    });
  });

  it("leaves a constraint violation inside a transaction unchanged", async () => {
    const base: any = fakeSql(connErr("ECONNREFUSED"));
    base.begin = () => Promise.reject(queryErr("23505"));
    const sql = wrapDbErrors(base);
    await expect(sql.begin(async () => {})).rejects.toMatchObject({ code: "23505" });
    await expect(sql.begin(async () => {})).rejects.not.toBeInstanceOf(DomainError);
  });

  it("returns non-query properties (e.g. sql.end) untouched", () => {
    const end = vi.fn();
    const base: any = fakeSql(connErr("ECONNREFUSED"));
    base.end = end;
    const sql = wrapDbErrors(base);
    expect((sql as any).end).toBe(end);
  });
});
