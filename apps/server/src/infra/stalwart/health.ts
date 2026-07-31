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
 */
export async function checkStalwart(input: {
  url: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
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
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
