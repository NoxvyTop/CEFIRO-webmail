import { DEFAULT_JMAP_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
import { log } from "../../core/logger";
import { resolveSessionUrls, type JmapAuthMode, type JmapUrlMode } from "./client";

/**
 * What the boot probe learned about the configured JMAP provider.
 *
 * - `reachable`: the provider answered. A 401/403 counts — discovery requires
 *   credentials and the probe deliberately sends none, so being refused proves
 *   the address, the DNS name, the port and the TLS chain are all good, which
 *   is exactly what a topology mistake breaks.
 * - `not-serving`: it answered with a 5xx. Up, but not serving JMAP.
 * - `unreachable`: connection refused/reset, DNS failure, an untrusted
 *   certificate, or the outbound deadline expiring.
 */
export type JmapProbeOutcome = "reachable" | "not-serving" | "unreachable";

export type JmapProbeResult = {
  outcome: JmapProbeOutcome;
  /** Absent when nothing answered. */
  status?: number;
  /** Present only when the provider handed back a session without credentials. */
  advertisedApiUrl?: string;
  /** What `urlMode` turns `advertisedApiUrl` into — the URL this process will use. */
  resolvedApiUrl?: string;
  /** Stringified transport failure, when `outcome` is `unreachable`. */
  error?: string;
};

/**
 * One unauthenticated `/.well-known/jmap` call at startup, logged (GH #188).
 *
 * Rationale: every mistake in this area — wrong hostname, a port only reachable
 * from another network, a private CA this process does not trust, a URL mode
 * that sends calls to an origin nobody can reach — used to surface as a 502 the
 * FIRST time a user opened their mail, hours after the deploy and far from the
 * person who could fix it. This makes it surface at boot instead, in the
 * deploy's own log stream.
 *
 * It never throws and it never blocks the boot. A provider that is simply not
 * up yet is normal (both start together in most compose files), so failing hard
 * here would turn an ordering race into a crash loop. The design note is
 * explicit about that: log, do not fail.
 *
 * TLS trust needs no knob of its own: Bun and Node both honour
 * `NODE_EXTRA_CA_CERTS`, so a provider behind a private/internal CA is a
 * deployment-level environment variable, not another config surface. There is
 * deliberately no "insecure"/skip-verification flag — see docs/PRODUCCION.md.
 */
export async function probeJmap(input: {
  url: string;
  urlMode: JmapUrlMode;
  authMode: JmapAuthMode;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<JmapProbeResult> {
  const base = input.url.replace(/\/$/, "");
  const deadlineFetch = withDeadlineFetch(
    input.fetchFn ?? fetch,
    "stalwart",
    input.timeoutMs ?? DEFAULT_JMAP_TIMEOUT_MS,
  );

  let result: JmapProbeResult;
  try {
    const res = await deadlineFetch(`${base}/.well-known/jmap`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    result = {
      outcome: res.status >= 500 ? "not-serving" : "reachable",
      status: res.status,
      ...(await advertisedUrls(res, base, input.urlMode)),
    };
  } catch (error) {
    result = { outcome: "unreachable", error: String(error) };
  }

  log(result.outcome === "reachable" ? "info" : "warn", "jmap provider probe", {
    url: base,
    urlMode: input.urlMode,
    authMode: input.authMode,
    ...result,
  });
  return result;
}

/**
 * The advertised/resolved `apiUrl` pair, when the response happens to carry a
 * session. Most providers demand credentials for discovery and answer 401, so
 * this is a bonus rather than the point — but when it IS there it is the single
 * most useful line in the log: it shows, side by side, what the provider
 * claims and what `JMAP_URL_MODE` makes this process actually call.
 */
async function advertisedUrls(
  res: Response,
  baseUrl: string,
  urlMode: JmapUrlMode,
): Promise<{ advertisedApiUrl?: string; resolvedApiUrl?: string }> {
  if (!res.ok) return {};
  try {
    const body = (await res.json()) as { apiUrl?: unknown };
    if (typeof body.apiUrl !== "string" || body.apiUrl === "") return {};
    const resolved = resolveSessionUrls(
      { apiUrl: body.apiUrl, eventSourceUrl: "", uploadUrl: "", downloadUrl: "" },
      baseUrl,
      urlMode,
    );
    return { advertisedApiUrl: body.apiUrl, resolvedApiUrl: resolved.apiUrl };
  } catch {
    // A body that is not JSON says nothing about reachability, which the status
    // already answered. Never let it turn a successful probe into a failure.
    return {};
  }
}
