import type { Db } from "./client";

/**
 * Cheap Postgres reachability probe for /api/health.
 *
 * Takes no `AbortSignal`, unlike the Stalwart probe beside it (GH #242), and
 * that is a limitation worth stating rather than hiding: cancelling a running
 * query in postgres.js means calling `.cancel()` on the lazy query object, and
 * `wrapDbErrors` (infra/db/client.ts) deliberately replaces that object with a
 * plain mapped Promise so every repo gets a 503 `database_unavailable` for
 * free — so by the time a caller holds the result there is nothing left to
 * cancel. What bounds this instead is server-side and already in place:
 * `connect_timeout` (10s) for a database that is unreachable, `statement_timeout`
 * (30s) for one that is merely stuck, both configured in createDb.
 *
 * The gap that leaves is small and different in kind from the one GH #242
 * closed: `select 1` on a live connection is sub-millisecond, so a probe
 * abandoned at its 2s budget costs one pooled connection until the statement
 * timeout, not a stream of outbound requests against a dependency that is
 * already struggling. `HealthCheck` accepts a signal and this is assignable to
 * it with one parameter fewer, so nothing here has to pretend to honour
 * something it cannot.
 */
export async function checkDb(sql: Db): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
