/**
 * The minimum useful metrics surface for this server (GH #208), rendered in the
 * Prometheus text exposition format.
 *
 * Before this there was nothing: `/api/health` answered a boolean and nobody
 * could tell whether a route had started failing, whether it had got slower, or
 * for how long a dependency had been down — only whether it was down *right
 * now*, and only if someone happened to look.
 *
 * Deliberately small. Three families answer the questions on-call actually
 * asks: how much traffic and how much of it failed (`..._requests_total`), how
 * slow it was (`..._request_duration_seconds`), and which dependency is down
 * (`cefiro_dependency_up`), plus the process start time, which is what makes a
 * crash loop legible and explains a counter that reset to zero. No client
 * library: the format is a dozen lines of text and a dependency that pulls in a
 * default-metrics collector would export more about the runtime than about the
 * service.
 */

/** What Prometheus expects for the text exposition format it scrapes. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Latency buckets in seconds, cumulative (`le`). The spread is deliberately
 * wide at the top: this process proxies JMAP to Stalwart under a ~10s outbound
 * deadline (core/deadline.ts), so a bucket set that ended at 1s would put every
 * interesting failure mode in `+Inf` and make the p99 unreadable exactly when
 * it matters.
 */
const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

/**
 * Methods that get their own label. Anything else collapses into `other`.
 *
 * Not paranoia: an HTTP method is an arbitrary token, so a scanner spraying
 * `PROPFIND`, `TRACK`, `<random>` at an unrouted path would mint one time
 * series per method it invents, forever, in a process that never restarts. A
 * metric a stranger can grow without bound is a memory leak with a scrape
 * endpoint in front of it.
 */
const KNOWN_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/** Label used when no route matched — see `routeLabel`. */
export const UNMATCHED_ROUTE = "<unmatched>";

/**
 * The route label for a request: the matched route *pattern*, never the
 * concrete path.
 *
 * Same reasoning as core/access-log.ts `loggedPath` — take the last
 * non-wildcard match, because each router mounted on /api/mail registers its
 * own `use("*")` guard and a request refused by a guard never reaches the
 * endpoint handler. But the fallback differs, and the difference is the whole
 * point: an access log falls back to the raw path (one line, bounded by the
 * request), while a metric label is kept forever. `/api/nope`, `/wp-login.php`
 * and every other path a scanner invents must therefore collapse into one
 * constant series rather than mint a new one each.
 */
export function routeLabel(matchedRoutes: readonly { path: string }[]): string {
  for (let i = matchedRoutes.length - 1; i >= 0; i -= 1) {
    const path = matchedRoutes[i]!.path;
    if (!path.endsWith("*")) return path;
  }
  return UNMATCHED_ROUTE;
}

/** Normalizes a request method to a bounded label. See `KNOWN_METHODS`. */
export function methodLabel(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : "other";
}

export type RequestSample = {
  method: string;
  route: string;
  status: number;
  durationMs: number;
};

export type Metrics = {
  /** Records one finished request. Called once per response, from createApp. */
  recordRequest(sample: RequestSample): void;
  /**
   * Renders the whole registry. `dependencies` comes from the cached
   * /api/health probe (core/health.ts) rather than from fresh outbound calls —
   * a scrape must not be a way to generate load on Stalwart (GH #220).
   */
  render(dependencies: Record<string, boolean>): string;
  /** Number of tracked request series — for tests and cardinality checks. */
  readonly size: number;
};

type CounterEntry = { method: string; route: string; status: number; value: number };
type HistogramEntry = {
  method: string;
  route: string;
  /** Per-bucket (non-cumulative) counts; rendered as a running total. */
  buckets: number[];
  sum: number;
  count: number;
};

/**
 * Escapes a Prometheus label value. Today's labels (route patterns, methods,
 * check names) contain none of these characters, but a label value that ever
 * did would produce a line no scraper can parse, and a metrics endpoint that
 * silently breaks the whole scrape is worse than one that is missing.
 */
function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function labels(pairs: [string, string][]): string {
  return pairs.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",");
}

/**
 * Formats a sample value. JavaScript's shortest round-trip representation is
 * already what the exposition format wants — a bare integer where the value is
 * one, and a decimal otherwise. Notably NOT a fixed number of decimals: a
 * bucket boundary must render as `0.005`, because the `le` label is part of the
 * series identity and `0.005000` would name a different bucket to every other
 * exporter's.
 */
function formatValue(value: number): string {
  return String(value);
}

export function createMetrics(input: { now?: () => number } = {}): Metrics {
  const now = input.now ?? Date.now;
  // Captured once: `cefiro_process_start_time_seconds` is what tells an
  // operator that the counters reset because the process restarted, rather than
  // because traffic stopped.
  const startedAtSeconds = now() / 1000;
  const counters = new Map<string, CounterEntry>();
  const histograms = new Map<string, HistogramEntry>();

  return {
    recordRequest(sample: RequestSample): void {
      const method = methodLabel(sample.method);
      const { route } = sample;
      const status = String(sample.status);

      const counterKey = `${method}\u0000${route}\u0000${status}`;
      const counter = counters.get(counterKey);
      if (counter) counter.value += 1;
      else counters.set(counterKey, { method, route, status: sample.status, value: 1 });

      const histogramKey = `${method}\u0000${route}`;
      let histogram = histograms.get(histogramKey);
      if (!histogram) {
        histogram = {
          method,
          route,
          buckets: DURATION_BUCKETS_SECONDS.map(() => 0),
          sum: 0,
          count: 0,
        };
        histograms.set(histogramKey, histogram);
      }
      const seconds = Math.max(0, sample.durationMs) / 1000;
      histogram.sum += seconds;
      histogram.count += 1;
      for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i += 1) {
        if (seconds <= DURATION_BUCKETS_SECONDS[i]!) {
          histogram.buckets[i]! += 1;
          break;
        }
      }
    },

    render(dependencies: Record<string, boolean>): string {
      const lines: string[] = [];

      lines.push(
        "# HELP cefiro_http_requests_total Total HTTP requests answered, by route, method and status.",
        "# TYPE cefiro_http_requests_total counter",
      );
      // Sorted so a diff between two scrapes is readable by a human and the
      // output is deterministic for tests.
      for (const key of [...counters.keys()].sort()) {
        const entry = counters.get(key)!;
        const labelSet = labels([
          ["method", entry.method],
          ["route", entry.route],
          ["status", String(entry.status)],
        ]);
        lines.push(`cefiro_http_requests_total{${labelSet}} ${entry.value}`);
      }

      lines.push(
        "# HELP cefiro_http_request_duration_seconds Request latency in seconds, by route and method.",
        "# TYPE cefiro_http_request_duration_seconds histogram",
      );
      for (const key of [...histograms.keys()].sort()) {
        const entry = histograms.get(key)!;
        const base: [string, string][] = [
          ["method", entry.method],
          ["route", entry.route],
        ];
        // Prometheus histogram buckets are CUMULATIVE: each `le` reports every
        // observation at or below it, and `+Inf` must equal `_count`.
        let cumulative = 0;
        for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i += 1) {
          cumulative += entry.buckets[i]!;
          const le = formatValue(DURATION_BUCKETS_SECONDS[i]!);
          lines.push(
            `cefiro_http_request_duration_seconds_bucket{${labels([...base, ["le", le]])}} ${cumulative}`,
          );
        }
        lines.push(
          `cefiro_http_request_duration_seconds_bucket{${labels([...base, ["le", "+Inf"]])}} ${entry.count}`,
          `cefiro_http_request_duration_seconds_sum{${labels(base)}} ${formatValue(entry.sum)}`,
          `cefiro_http_request_duration_seconds_count{${labels(base)}} ${entry.count}`,
        );
      }

      lines.push(
        "# HELP cefiro_dependency_up Dependency reachable on the last health probe (1 up, 0 down).",
        "# TYPE cefiro_dependency_up gauge",
      );
      for (const name of Object.keys(dependencies).sort()) {
        lines.push(
          `cefiro_dependency_up{${labels([["dependency", name]])}} ${dependencies[name] ? 1 : 0}`,
        );
      }

      lines.push(
        "# HELP cefiro_process_start_time_seconds Start time of the process since the Unix epoch.",
        "# TYPE cefiro_process_start_time_seconds gauge",
        `cefiro_process_start_time_seconds ${formatValue(startedAtSeconds)}`,
      );

      // Trailing newline: the exposition format requires the last line to be
      // terminated, and some scrapers reject the payload without it.
      return `${lines.join("\n")}\n`;
    },

    get size(): number {
      return counters.size;
    },
  };
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/**
 * Constant-time check of an `Authorization: Bearer <token>` header against the
 * configured scrape token.
 *
 * Both sides are hashed first (the same trick sessions.ts uses to store a
 * session token) so the comparison runs over two fixed 32-byte digests: a plain
 * string compare would leak the length of the secret and how many of its
 * leading characters a guess got right, and the loop below deliberately has no
 * early exit.
 */
export async function bearerTokenMatches(
  header: string | undefined,
  expected: string,
): Promise<boolean> {
  const scheme = "bearer ";
  if (!header || header.slice(0, scheme.length).toLowerCase() !== scheme) return false;
  const provided = header.slice(scheme.length).trim();
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
