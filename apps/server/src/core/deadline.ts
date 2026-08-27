import { DomainError } from "./errors";
import { log } from "./logger";
import { recordOutbound } from "./metrics";

// Outbound deadlines, one per upstream. Explicit rather than inherited from a
// single shared number, because the three services this server calls have
// latency profiles an order of magnitude apart: a ceiling loose enough for an
// AI generation is no ceiling at all for a mailbox listing.
//
// JMAP (Stalwart, or any other RFC 8620 provider): a mailbox listing or an
// Email/get is a sub-second call to a service that is normally on the same host
// or LAN. 10s leaves two orders of magnitude of headroom and still fails well
// inside the patience of whatever reverse proxy sits in front of us.
export const DEFAULT_JMAP_TIMEOUT_MS = 10_000;
// AI providers: a thread summary is a real generation of up to 1024 tokens,
// frequently against a self-hosted or rate-limited endpoint. Tens of seconds
// is normal there, not broken, so a JMAP-sized ceiling would turn healthy
// summaries into errors. 60s bounds the wait without doing that.
export const DEFAULT_AI_TIMEOUT_MS = 60_000;
// OIDC: discovery and token exchange are two small JSON round trips, but they
// sit on the login path and cross the public internet to the identity
// provider, so they get room for a cold TLS handshake and no more. The third
// OIDC call, the JWKS fetch, is already bounded by jose's own 5s
// `timeoutDuration` default and needs nothing from us.
export const DEFAULT_OIDC_TIMEOUT_MS = 10_000;

export const UPSTREAM_TIMEOUT_CODE = "upstream_timeout";

/**
 * The failure for "the upstream accepted the connection and never answered".
 *
 * Deliberately its own code, and 504 rather than the adapters' generic 502, so
 * an operator can tell a provider that timed out from a provider that answered
 * with garbage. Logged here rather than at the call sites because this is the
 * only place that knows the wait was a deadline: GH #165's worst symptom was
 * that a stalled upstream left no trace in the logs at all.
 */
export function upstreamTimeoutError(upstream: string, timeoutMs: number): DomainError {
  log("error", "upstream timed out", { upstream, timeoutMs });
  return new DomainError(UPSTREAM_TIMEOUT_CODE, 504, "errors.upstream_timeout");
}

/**
 * Times one outbound attempt and reports it to `/metrics` (GH #240).
 *
 * Every call this process makes to the JMAP provider, the identity provider and the AI
 * provider already passes through one of the two wrappers below, and both
 * already carry the dependency's name in order to write the timeout log line —
 * so this is the one place where "latency and error rate per dependency" can be
 * had without touching a single call site, and the one place that can tell a
 * deadline apart from a refused connection. It measures time to RESPONSE
 * HEADERS, the same window the deadline itself bounds: counting the body would
 * put the hours-long SSE stream in the same histogram as a mailbox listing.
 */
async function measured<T>(dependency: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const finish = (outcome: "ok" | "error" | "timeout") =>
    recordOutbound({ dependency, outcome, durationMs: Date.now() - startedAt });
  try {
    const result = await run();
    finish("ok");
    return result;
  } catch (error) {
    finish(
      error instanceof DomainError && error.code === UPSTREAM_TIMEOUT_CODE ? "timeout" : "error",
    );
    throw error;
  }
}

/**
 * Wraps `fetchFn` so every request it makes carries an outbound deadline.
 *
 * Two properties matter and are covered by deadline.test.ts:
 *
 * - The deadline is raced against the request, not merely handed to it as an
 *   abort signal. An upstream that accepts the connection and never answers
 *   may also never notice the abort, and that is precisely the case this
 *   exists for.
 * - Any `init.signal` the caller already passes (the SSE and attachment
 *   routes forward the browser's `c.req.raw.signal`) is composed with the
 *   deadline instead of being replaced: whichever fires first aborts the
 *   upstream, and a client disconnect keeps working after the deadline has
 *   stopped counting.
 *
 * The clock covers time-to-response-headers only. It is cleared the moment the
 * response resolves, so a long-lived body — the SSE event stream — is never
 * cut short by it.
 */
export function withDeadlineFetch(
  fetchFn: typeof fetch,
  upstream: string,
  timeoutMs: number,
): typeof fetch {
  const deadlineFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const client = init?.signal ?? null;
    let timeoutError: DomainError | undefined;
    let expire: (error: DomainError) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      expire = reject;
    });

    const timer = setTimeout(() => {
      timeoutError = upstreamTimeoutError(upstream, timeoutMs);
      controller.abort(timeoutError);
      expire(timeoutError);
    }, timeoutMs);

    if (client) {
      // No `removeEventListener` on the way out: the listener has to outlive
      // this call so a client that disconnects while the body is still
      // streaming still tears the upstream down, exactly as passing
      // `c.req.raw.signal` straight through to fetch used to do.
      if (client.aborted) controller.abort(client.reason);
      else {
        client.addEventListener("abort", () => controller.abort(client.reason), { once: true });
      }
    }

    const running = (async () => fetchFn(input, { ...init, signal: controller.signal }))();
    // The deadline may win the race; without a handler the loser's rejection
    // would surface as an unhandled promise rejection.
    running.catch(() => {});

    return measured(upstream, async () => {
      try {
        return await Promise.race([running, deadline]);
      } catch (error) {
        // When we are the ones who aborted, the upstream rejects with an
        // AbortError. Report the deadline, not that symptom.
        if (timeoutError) throw timeoutError;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
  };

  // `typeof fetch` also carries the runtime's `preconnect` extension, which
  // nothing in this codebase calls; the wrapper is a plain fetch function.
  return deadlineFetch as typeof fetch;
}

/**
 * Deadline for an outbound call that is not a bare `fetch` — the Anthropic SDK,
 * which owns its own transport. `run` receives a signal so a cooperative client
 * can cancel the in-flight request; the race guarantees the caller stops
 * waiting even when it does not.
 */
export function withDeadline<T>(
  upstream: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeoutError: DomainError | undefined;
  let expire: (error: DomainError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });

  const timer = setTimeout(() => {
    timeoutError = upstreamTimeoutError(upstream, timeoutMs);
    controller.abort(timeoutError);
    expire(timeoutError);
  }, timeoutMs);

  const running = (async () => run(controller.signal))();
  running.catch(() => {});

  return measured(upstream, async () => {
    try {
      return await Promise.race([running, deadline]);
    } catch (error) {
      if (timeoutError) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}
