import { DEFAULT_OIDC_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
import type { HealthCheck } from "../../core/health";
import type { SsoConfigRepo } from "../repos/sso-config";

/**
 * Cheap IdP reachability probe for /api/health (GH #281).
 *
 * Hits the issuer's unauthenticated discovery document
 * (`/.well-known/openid-configuration`) — the same document the login flow's
 * `oidc.discover()` reads — and reports whether the IdP is reachable and
 * serving. Any status < 500 counts as reachable: a 200 is the norm, and the
 * point is that the server answered rather than the connection failing or the
 * outbound deadline firing. Mirrors infra/jmap/health.ts for Stalwart.
 *
 * Carries the same outbound deadline as the login flow (core/deadline.ts) AND
 * the health probe's own much tighter budget signal (GH #242), so a hung IdP
 * can never hang readiness.
 */
export async function checkOidcReachable(input: {
  issuer: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** The health probe's budget, from core/health.ts. */
  signal?: AbortSignal;
}): Promise<boolean> {
  const wellKnown = `${input.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const deadlineFetch = withDeadlineFetch(
    input.fetchFn ?? fetch,
    "oidc",
    input.timeoutMs ?? DEFAULT_OIDC_TIMEOUT_MS,
  );
  try {
    const res = await deadlineFetch(wellKnown, {
      method: "GET",
      headers: { accept: "application/json" },
      // withDeadlineFetch composes this with its own deadline, so whichever
      // fires first aborts the request.
      signal: input.signal,
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * How long a HEALTHY IdP result is reused (GH #281).
 *
 * Deliberately far longer than the whole-health cache (DEFAULT_HEALTH_CACHE_MS
 * = 5s in core/health.ts): the IdP is a THIRD party, and turning an
 * unauthenticated /api/health into a heartbeat against it is the amplification
 * index.ts refused to open for OIDC discovery (#194). With this floor, no
 * volume of health polls can cost the IdP more than one discovery per minute —
 * yet an SSO-only instance whose IdP has been down for a minute still reports
 * degraded, the window a load balancer's own probe interval already lives in.
 */
export const DEFAULT_OIDC_READINESS_OK_CACHE_MS = 60_000;

/**
 * How long a DOWN result is reused. Short — matching the whole-health cache —
 * so a recovered IdP is seen within one health window and a single transient
 * miss cannot pin the instance out of rotation for the full OK window. A down
 * server being probed once every few seconds is trivial load.
 */
export const DEFAULT_OIDC_READINESS_DOWN_CACHE_MS = 5_000;

/**
 * Readiness check for the OIDC identity provider (GH #281).
 *
 * WHY readiness cares: regular users of this webmail log in ONLY through SSO —
 * there is no per-user password route (see modules/auth/router.ts); the
 * break-glass bootstrap login is not a user-facing path. So on an instance with
 * SSO configured, an IdP it cannot reach means nobody can sign in, yet
 * /api/health used to report `ok` and a load balancer kept routing to it. This
 * check makes that instance report `degraded` so it is drained.
 *
 * WHY it does not reintroduce #194's amplification: the result is cached (long
 * while healthy, briefly while down) and a probe already in flight is shared,
 * so the IdP sees at most one discovery per cache window however many clients
 * poll /api/health — the shape core/health.ts gives every check, with a far
 * longer healthy TTL because the IdP is a third party. This is the "cached
 * probe" the issue asks for.
 *
 * WHY only when SSO is configured: an instance with no SSO has no IdP to depend
 * on, so the check reports healthy with no outbound call. SSO config is read
 * fresh each probe (it lives in the DB and an admin can change it at runtime),
 * so configuring SSO starts covering the IdP without a restart.
 *
 * WHY the AI provider is NOT here: it is opt-in and non-critical, so draining an
 * instance because summarize/draft is unreachable would be a false negative —
 * the over-reaction #194 warned against, not a fix for it.
 */
export function createOidcReadinessCheck(input: {
  ssoConfig: Pick<SsoConfigRepo, "getPublic">;
  timeoutMs?: number;
  okCacheMs?: number;
  downCacheMs?: number;
  /** Injectable clock, matching core/health.ts; defaults to `Date.now`. */
  now?: () => number;
  fetchFn?: typeof fetch;
}): HealthCheck {
  const okCacheMs = input.okCacheMs ?? DEFAULT_OIDC_READINESS_OK_CACHE_MS;
  const downCacheMs = input.downCacheMs ?? DEFAULT_OIDC_READINESS_DOWN_CACHE_MS;
  const now = input.now ?? Date.now;
  let cached: { healthy: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  return async (signal) => {
    const sso = await input.ssoConfig.getPublic();
    // No SSO configured → no IdP dependency → nothing to drain over.
    if (!sso) return true;
    if (cached) {
      const ttl = cached.healthy ? okCacheMs : downCacheMs;
      if (now() - cached.at < ttl) return cached.healthy;
    }
    if (inFlight) return inFlight;
    inFlight = checkOidcReachable({
      issuer: sso.issuer,
      timeoutMs: input.timeoutMs,
      fetchFn: input.fetchFn,
      signal,
    }).then((healthy) => {
      cached = { healthy, at: now() };
      inFlight = null;
      return healthy;
    });
    return inFlight;
  };
}
