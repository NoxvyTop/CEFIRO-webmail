import postgres from "postgres";
import { DomainError } from "../../core/errors";

/**
 * Tunable limits for the Postgres client. Every field is optional: `createDb`
 * falls back to the DEFAULT_DB_* values below, so a caller that passes nothing
 * (the migrate script, the test harness) still gets a bounded pool.
 */
export type DbOptions = {
  /** Pool size — postgres `max`. */
  poolMax?: number;
  /** Seconds to wait for a new connection — postgres `connect_timeout`. */
  connectTimeoutS?: number;
  /** Seconds an idle pooled connection is kept before release — postgres `idle_timeout`. */
  idleTimeoutS?: number;
  /** Server-side per-statement cap in ms — postgres `connection.statement_timeout`. */
  statementTimeoutMs?: number;
};

// Bounded defaults (GH #191). Before this, the pool opened with only `max: 10`
// and no timeouts, so a slow or locked query held its pooled connection
// forever; ten of those exhausted the pool and stalled every request with no
// error at all — the database twin of the outbound hang GH #165 bounded for
// HTTP upstreams (see core/deadline.ts).
//
// - connect_timeout 10s: a TCP+auth handshake to a Postgres that is normally on
//   the same host or LAN is sub-second; 10s absorbs a cold or briefly contended
//   server yet fails fast enough that an unreachable DB surfaces as a 503
//   instead of hanging. The same ceiling deadline.ts gives the (also
//   same-host/LAN) Stalwart upstream.
// - idle_timeout 300s: hand connections idle for 5 min back to the server so
//   the pool does not pin ten backends through quiet periods, while staying
//   long enough to avoid reconnect churn under steady traffic.
// - statement_timeout 30s: cap any single query server-side so a slow or locked
//   one is cancelled (SQLSTATE 57014) instead of holding its connection
//   indefinitely — the core hang this fixes. 30s sits far above the app's
//   sub-second queries (session lookup, CRUD) yet bounds pathological locks.
// - max 10: unchanged. One instance's working set fits comfortably under
//   Postgres' default max_connections (100), leaving headroom for migrations
//   and admin sessions. Kept as-is and made overridable via DB_POOL_MAX rather
//   than changed blindly, to avoid a surprise capacity shift.
export const DEFAULT_DB_POOL_MAX = 10;
export const DEFAULT_DB_CONNECT_TIMEOUT_S = 10;
export const DEFAULT_DB_IDLE_TIMEOUT_S = 300;
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 30_000;

export function buildDbOptions(options: DbOptions = {}): postgres.Options<{}> {
  return {
    max: options.poolMax ?? DEFAULT_DB_POOL_MAX,
    connect_timeout: options.connectTimeoutS ?? DEFAULT_DB_CONNECT_TIMEOUT_S,
    idle_timeout: options.idleTimeoutS ?? DEFAULT_DB_IDLE_TIMEOUT_S,
    // statement_timeout is a server-side GUC, not a client option, so postgres
    // sends it as a startup parameter under `connection`.
    connection: {
      statement_timeout: options.statementTimeoutMs ?? DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    },
    onnotice: () => {},
  };
}

export const DATABASE_UNAVAILABLE_CODE = "database_unavailable";

// Codes that mean "the connection/transport failed", NOT "a healthy server
// rejected the query". The first four are raised by postgres.js itself
// (src/connection.js, src/index.js); the rest are Node socket errno codes that
// reach us verbatim from the socket 'error' event. A server-side query error —
// a constraint violation (23505), an undefined table (42P01), or the
// statement_timeout cancel (57014) — carries a 5-character SQLSTATE code that is
// deliberately absent from this set, so it passes through untouched and is never
// mislabeled as the database being unavailable. This is the database analogue
// of the transport-vs-status split infra/stalwart/jmap.ts draws for Stalwart
// (GH #187).
const CONNECTION_ERROR_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
]);

export function isConnectionError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && CONNECTION_ERROR_CODES.has(code);
}

/**
 * Maps a Postgres connection/transport failure to a dependency DomainError, so
 * app.onError logs it as `warn/domain error` and returns 503 rather than the
 * 500 `internal` bucket reserved for our own bugs. Anything else — a server-side
 * query error, a client usage error, an already-built DomainError — is returned
 * unchanged.
 */
export function mapDbError(err: unknown): unknown {
  if (err instanceof DomainError) return err;
  if (isConnectionError(err)) {
    return new DomainError(DATABASE_UNAVAILABLE_CODE, 503, "errors.database_unavailable");
  }
  return err;
}

// A tagged-template call `sql`...`` receives the template strings array (which
// carries `.raw`) as its first argument; every other call shape — `sql("ident")`,
// `sql(rows)`, the helpers behind `sql.json(...)` — builds a query *fragment*
// that is embedded in a template, never awaited on its own, and must pass
// through untouched. This is exactly the test postgres.js itself uses to tell
// the two apart.
function isTaggedTemplateCall(args: unknown[]): boolean {
  const first = args[0] as { raw?: unknown } | undefined;
  return Array.isArray(first) && Array.isArray(first.raw);
}

function rejectMapped<T>(promise: PromiseLike<T>): Promise<T> {
  // Promise.resolve adopts the lazy postgres Query (a thenable), running it
  // once and preserving its resolved Result, while giving us a real Promise.
  return Promise.resolve(promise).then(undefined, (err) => {
    throw mapDbError(err);
  });
}

/**
 * Wraps the postgres client so a connection/transport failure on ANY query or
 * transaction surfaces as a 503 `database_unavailable` DomainError, without
 * each repo needing its own try/catch (the DB counterpart to how
 * infra/stalwart/jmap.ts wraps its fetch — GH #187).
 *
 * Repos only ever await query results (verified: no `.cursor`/`.values`/
 * `.forEach` usage across apps/server), so returning a mapped Promise in place
 * of the lazy Query is transparent — the resolved postgres `Result` is passed
 * through untouched on success. A fragment (`sql(rows)`, `sql.json(...)`) or any
 * non-query property is returned exactly as-is.
 */
export function wrapDbErrors<S extends (...args: any[]) => any>(sql: S): S {
  return new Proxy(sql, {
    apply(target, thisArg, args) {
      const result = target.apply(thisArg, args);
      return isTaggedTemplateCall(args) ? rejectMapped(result) : result;
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // sql.begin runs its queries on a reserved connection whose failures
      // reject the returned promise rather than flowing through the apply trap
      // above, so its rejection has to be mapped here too. Nothing in the repos
      // uses sql.reserve/sql.listen, which would need the same treatment.
      if (prop === "begin" && typeof value === "function") {
        return (...args: unknown[]) => rejectMapped(value.apply(target, args));
      }
      return value;
    },
  }) as S;
}

export function createDb(url: string, options?: DbOptions) {
  return wrapDbErrors(postgres(url, buildDbOptions(options)));
}

export type Db = ReturnType<typeof createDb>;
