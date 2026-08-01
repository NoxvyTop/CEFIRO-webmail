import { describe, expect, it } from "vitest";
import {
  bearerTokenMatches,
  createMetrics,
  methodLabel,
  routeLabel,
  UNMATCHED_ROUTE,
} from "./metrics";

/** Reads one exposed sample by its full `name{labels}` prefix. */
function sample(rendered: string, prefix: string): string | undefined {
  return rendered
    .split("\n")
    .find((line) => line.startsWith(`${prefix} `))
    ?.slice(prefix.length + 1);
}

describe("routeLabel (GH #208)", () => {
  it("names the endpoint by its pattern, not the concrete path", () => {
    expect(routeLabel([{ path: "/api/mail/*" }, { path: "/api/mail/threads/:id" }])).toBe(
      "/api/mail/threads/:id",
    );
  });

  it("still names the endpoint when a wildcard guard matched after it", () => {
    // Every router mounted on /api/mail registers its own use("*"), so wildcard
    // entries appear on both sides of the endpoint's own entry.
    expect(
      routeLabel([{ path: "/api/mail/*" }, { path: "/api/mail/messages/:id" }, { path: "*" }]),
    ).toBe("/api/mail/messages/:id");
  });

  it("collapses everything unrouted into one series instead of one per path", () => {
    // The cardinality guard: a label is kept forever, so a scanner inventing
    // paths must not be able to mint a time series per attempt.
    expect(routeLabel([])).toBe(UNMATCHED_ROUTE);
    expect(routeLabel([{ path: "*" }])).toBe(UNMATCHED_ROUTE);
  });
});

describe("methodLabel (GH #208)", () => {
  it("keeps the methods this API actually serves", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(methodLabel(method)).toBe(method);
    }
    expect(methodLabel("get")).toBe("GET");
  });

  it("collapses invented methods, which are an unbounded label otherwise", () => {
    expect(methodLabel("PROPFIND")).toBe("other");
    expect(methodLabel("WHATEVER-A-SCANNER-SENDS")).toBe("other");
  });
});

describe("request metrics (GH #208)", () => {
  it("counts requests by route, method and status", () => {
    const metrics = createMetrics();
    metrics.recordRequest({ method: "GET", route: "/api/health", status: 200, durationMs: 1 });
    metrics.recordRequest({ method: "GET", route: "/api/health", status: 200, durationMs: 2 });
    metrics.recordRequest({ method: "GET", route: "/api/health", status: 503, durationMs: 3 });

    const rendered = metrics.render({});
    expect(
      sample(rendered, 'cefiro_http_requests_total{method="GET",route="/api/health",status="200"}'),
    ).toBe("2");
    expect(
      sample(rendered, 'cefiro_http_requests_total{method="GET",route="/api/health",status="503"}'),
    ).toBe("1");
    expect(rendered).toContain("# TYPE cefiro_http_requests_total counter");
  });

  it("keeps one series per distinct label set", () => {
    const metrics = createMetrics();
    metrics.recordRequest({ method: "GET", route: "/api/health", status: 200, durationMs: 1 });
    metrics.recordRequest({ method: "GET", route: "/api/health", status: 200, durationMs: 1 });
    metrics.recordRequest({ method: "POST", route: "/api/health", status: 200, durationMs: 1 });
    expect(metrics.size).toBe(2);
  });

  it("exposes a cumulative latency histogram whose +Inf bucket equals the count", () => {
    const metrics = createMetrics();
    // 2ms, 30ms and 3s: one under the first bucket, one in the middle, one high.
    for (const durationMs of [2, 30, 3000]) {
      metrics.recordRequest({ method: "GET", route: "/api/mail/threads", status: 200, durationMs });
    }

    const rendered = metrics.render({});
    const base = 'method="GET",route="/api/mail/threads"';
    expect(sample(rendered, `cefiro_http_request_duration_seconds_bucket{${base},le="0.005"}`)).toBe(
      "1",
    );
    // Cumulative: the 2ms and the 30ms request are both at or below 50ms.
    expect(sample(rendered, `cefiro_http_request_duration_seconds_bucket{${base},le="0.05"}`)).toBe(
      "2",
    );
    expect(sample(rendered, `cefiro_http_request_duration_seconds_bucket{${base},le="+Inf"}`)).toBe(
      "3",
    );
    expect(sample(rendered, `cefiro_http_request_duration_seconds_count{${base}}`)).toBe("3");
    expect(
      Number(sample(rendered, `cefiro_http_request_duration_seconds_sum{${base}}`)),
    ).toBeCloseTo(3.032, 6);
  });

  it("counts a request slower than every bucket only in +Inf", () => {
    const metrics = createMetrics();
    metrics.recordRequest({ method: "GET", route: "/slow", status: 504, durationMs: 30_000 });
    const rendered = metrics.render({});
    const base = 'method="GET",route="/slow"';
    expect(sample(rendered, `cefiro_http_request_duration_seconds_bucket{${base},le="10"}`)).toBe(
      "0",
    );
    expect(sample(rendered, `cefiro_http_request_duration_seconds_bucket{${base},le="+Inf"}`)).toBe(
      "1",
    );
  });

  it("renders dependency state as a gauge, from whatever the health probe reported", () => {
    const rendered = createMetrics().render({ postgres: true, stalwart: false });
    expect(sample(rendered, 'cefiro_dependency_up{dependency="postgres"}')).toBe("1");
    expect(sample(rendered, 'cefiro_dependency_up{dependency="stalwart"}')).toBe("0");
    expect(rendered).toContain("# TYPE cefiro_dependency_up gauge");
  });

  it("exposes the process start time, so a counter reset reads as a restart", () => {
    const metrics = createMetrics({ now: () => 1_700_000_000_000 });
    expect(sample(metrics.render({}), "cefiro_process_start_time_seconds")).toBe("1700000000");
  });

  it("renders a parseable payload with a HELP and TYPE per family and a trailing newline", () => {
    const metrics = createMetrics();
    metrics.recordRequest({ method: "GET", route: "/api/health", status: 200, durationMs: 1 });
    const rendered = metrics.render({ postgres: true });

    expect(rendered.endsWith("\n")).toBe(true);
    for (const family of [
      "cefiro_http_requests_total",
      "cefiro_http_request_duration_seconds",
      "cefiro_dependency_up",
      "cefiro_process_start_time_seconds",
    ]) {
      expect(rendered).toContain(`# HELP ${family} `);
      expect(rendered).toContain(`# TYPE ${family} `);
    }
    // No line may be left half-built (an unclosed label set breaks the scrape).
    for (const line of rendered.split("\n").filter(Boolean)) {
      if (line.startsWith("#")) continue;
      expect(line).toMatch(/^[a-z_]+(\{.*\})? -?[\d.]+$/);
    }
  });

  it("escapes a label value instead of emitting a line no scraper can parse", () => {
    const metrics = createMetrics();
    metrics.recordRequest({ method: "GET", route: 'a"b\\c', status: 200, durationMs: 1 });
    expect(metrics.render({})).toContain('route="a\\"b\\\\c"');
  });
});

describe("metrics bearer token (GH #208)", () => {
  it("accepts the configured token", async () => {
    await expect(bearerTokenMatches("Bearer s3cret", "s3cret")).resolves.toBe(true);
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", async () => {
    await expect(bearerTokenMatches("bearer s3cret", "s3cret")).resolves.toBe(true);
  });

  it("rejects a wrong token, including a correct prefix of it", async () => {
    await expect(bearerTokenMatches("Bearer s3cre", "s3cret")).resolves.toBe(false);
    await expect(bearerTokenMatches("Bearer s3cretx", "s3cret")).resolves.toBe(false);
    await expect(bearerTokenMatches("Bearer ", "s3cret")).resolves.toBe(false);
  });

  it("rejects a missing header or another auth scheme", async () => {
    await expect(bearerTokenMatches(undefined, "s3cret")).resolves.toBe(false);
    await expect(bearerTokenMatches("s3cret", "s3cret")).resolves.toBe(false);
    await expect(bearerTokenMatches("Basic czNjcmV0", "s3cret")).resolves.toBe(false);
  });
});
