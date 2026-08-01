import type { HealthResponse } from "@webmail/shared";

export type HealthCheck = () => Promise<boolean>;

/**
 * Budget for the WHOLE /api/health probe (GH #212).
 *
 * The checks used to run one after another, each with its own upstream ceiling:
 * ~10s for Stalwart (core/deadline.ts) plus ~10s to reach Postgres
 * (infra/db/client.ts) — up to ~20s. The container's own probe allows 5s
 * (`HEALTHCHECK --timeout=5s --retries=3`), so a merely SLOW Stalwart got a
 * perfectly healthy container killed.
 *
 * Two things fix that and both are needed: the checks run in parallel, so the
 * endpoint costs the slowest one rather than their sum, and each gets this
 * budget, comfortably under the 5s the probe waits. A check that overruns it
 * counts as failed — this is a readiness signal, and a dependency that cannot
 * answer in two seconds is not one this instance can serve traffic with.
 */
export const DEFAULT_HEALTH_BUDGET_MS = 2_000;

/**
 * How long a probe result is reused (GH #220).
 *
 * /api/health takes no session and used to fire a fresh outbound request to
 * Stalwart on EVERY poll — the amplification vector index.ts explicitly refuses
 * for OIDC discovery three lines above where it wires this. With the result
 * cached, N polls cost at most one outbound probe per window no matter who is
 * asking, so cheap requests to this server can no longer be turned into load on
 * Stalwart.
 *
 * Short enough that the container's 30s HEALTHCHECK interval always gets a
 * fresh probe and an operator polling by hand sees a real state change within
 * seconds; long enough that a burst collapses into a single upstream call.
 */
export const DEFAULT_HEALTH_CACHE_MS = 5_000;

export type HealthProbeResult = { body: HealthResponse; healthy: boolean };

/**
 * Runs one check under its own budget. Never rejects: a check that throws or
 * overruns is a failed check, not a failed endpoint — /api/health must always
 * answer, and answer quickly, or it cannot do its job at all.
 */
async function runCheck(check: HealthCheck, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
  });
  const attempt = (async () => {
    try {
      return await check();
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([attempt, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the /api/health probe: checks in parallel, each bounded by its own
 * budget (GH #212), the outcome cached for a few seconds and de-duplicated
 * while one is in flight (GH #220).
 *
 * The cache lives in this closure, so it is per app instance — a test that
 * builds its own app always starts from a cold probe.
 */
export function createHealthProbe(input: {
  checks: Record<string, HealthCheck>;
  budgetMs?: number;
  cacheMs?: number;
  /** Injectable clock, matching core/rate-limit.ts; defaults to `Date.now`. */
  now?: () => number;
}): () => Promise<HealthProbeResult> {
  const budgetMs = input.budgetMs ?? DEFAULT_HEALTH_BUDGET_MS;
  const cacheMs = input.cacheMs ?? DEFAULT_HEALTH_CACHE_MS;
  const now = input.now ?? Date.now;
  let cached: { result: HealthProbeResult; at: number } | null = null;
  let inFlight: Promise<HealthProbeResult> | null = null;

  async function probeAll(): Promise<HealthProbeResult> {
    const results: Record<string, boolean> = {};
    await Promise.all(
      Object.entries(input.checks).map(async ([name, check]) => {
        results[name] = await runCheck(check, budgetMs);
      }),
    );
    const healthy = Object.values(results).every(Boolean);
    return { body: { status: healthy ? "ok" : "degraded", checks: results }, healthy };
  }

  return function probe(): Promise<HealthProbeResult> {
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.result);
    // Sharing the in-flight probe matters as much as the cache: without it a
    // burst arriving on a cold cache would each start their own round of
    // upstream calls, which is precisely what this exists to prevent.
    if (inFlight) return inFlight;
    inFlight = probeAll().then((result) => {
      cached = { result, at: now() };
      inFlight = null;
      return result;
    });
    return inFlight;
  };
}
