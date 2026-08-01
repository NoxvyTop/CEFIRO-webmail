import { DEFAULT_STALWART_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";

/**
 * Cheap Stalwart reachability probe for /api/health (GH #197).
 *
 * Hits the unauthenticated JMAP session discovery endpoint
 * (`/.well-known/jmap`) — the same path the JMAP client fetches — and reports
 * whether Stalwart is reachable and serving. A 401 (no credentials sent) is
 * expected and healthy: it proves the server answered. Any 5xx means it is up
 * but not serving, and a transport failure or the outbound deadline firing
 * means it is unreachable.
 *
 * The request carries the same outbound deadline as every other Stalwart call
 * (core/deadline.ts) so a hung Stalwart can never hang the health endpoint.
 *
 * It also carries the probe's own `signal` (GH #242). The two bound different
 * things and both are needed: the deadline is this dependency's ceiling (~10s),
 * while the signal is the health probe's much tighter budget (2s). Without the
 * signal, a check the probe had already given up on kept running to the FULL
 * outbound deadline — the request was abandoned, never cancelled, so every
 * cold-cache poll of a slow Stalwart left seconds of outbound work behind it.
 */
export async function checkStalwart(input: {
  url: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** The health probe's budget, from core/health.ts. */
  signal?: AbortSignal;
}): Promise<boolean> {
  const base = input.url.replace(/\/$/, "");
  const deadlineFetch = withDeadlineFetch(
    input.fetchFn ?? fetch,
    "stalwart",
    input.timeoutMs ?? DEFAULT_STALWART_TIMEOUT_MS,
  );
  try {
    const res = await deadlineFetch(`${base}/.well-known/jmap`, {
      method: "GET",
      headers: { accept: "application/json" },
      // withDeadlineFetch composes this with its own deadline rather than
      // replacing it, so whichever fires first aborts the request.
      signal: input.signal,
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
