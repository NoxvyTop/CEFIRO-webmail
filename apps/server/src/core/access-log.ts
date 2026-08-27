import { log } from "./logger";

type Level = "info" | "warn" | "error";

/**
 * Log level for an HTTP outcome, chosen by status class — a 500 is not the
 * same event as a 200 and must not be greppable the same way.
 *
 * - 5xx -> error: the server failed. Nothing the client did can fix it, so
 *   someone has to look. This is the only class that should page anyone.
 * - 4xx -> warn: the request was refused. Expected in normal operation (an
 *   expired session polling /api/auth/me, a stale link, a scanner probing
 *   unknown paths), so it is not an error — but it is the class you grep
 *   when a user reports a problem with their traceId.
 * - everything else -> info: the ordinary access record.
 *
 * Shared with core/error-response.ts so the two lines a failed request
 * produces (the error envelope and this access record) never disagree about
 * how serious the same status is.
 */
export function levelForStatus(status: number): Level {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

/**
 * The path to record for a request: the matched route pattern when there is
 * one, and only otherwise the raw path.
 *
 * Why the pattern and not the raw path. Every secret this API handles travels
 * in the query string, never in a path segment — the OIDC authorization code
 * (`/api/auth/callback?code=...`), full-text search terms (`?query=`),
 * recipient addresses (`?to=`, `?excludeTo=`), contact lookups (`?q=`) and
 * attachment filenames (`?name=`). Callers pass Hono's `c.req.path`, which is
 * query-free by construction, so none of that can reach the log. What path
 * segments do carry is per-user object ids (message, thread, blob, contact
 * and user ids). Those are not credentials, but a log line per read of
 * `/api/mail/threads/<id>` is a reading history, and it answers none of the
 * questions an access log exists for. `/api/mail/threads/:threadId` answers
 * all of them — which endpoint, how often, how slow — and carries no ids.
 *
 * The last non-wildcard match is taken rather than "where the chain stopped".
 * Three routers are mounted on /api/mail (mail, sieve, ai, contacts) and each
 * registers its own `use("*")` guard, so wildcard entries appear both before
 * and after the endpoint's own entry in the match list; and a request refused
 * by a guard never reaches the endpoint handler at all. Scanning back for the
 * most specific match names the endpoint in both cases, which matters most
 * precisely for the 401/403 that stopped early.
 */
export function loggedPath(
  matchedRoutes: readonly { path: string }[],
  rawPath: string,
): string {
  for (let i = matchedRoutes.length - 1; i >= 0; i -= 1) {
    const path = matchedRoutes[i]!.path;
    if (!path.endsWith("*")) return path;
  }
  return rawPath;
}

/**
 * One access record per response. Emitted from the single global middleware
 * in createApp, which is the only place that sees every response — including
 * the ~90 hand-built error envelopes that return straight from a handler and
 * never reach onError. Without this line the traceId handed to the client
 * leads nowhere (GH #166).
 */
export function logAccess(entry: {
  traceId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}): void {
  log(levelForStatus(entry.status), "request", entry);
}
