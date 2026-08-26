import { describe, expect, it } from "vitest";
import {
  bearerTokenMatches,
  createMetrics,
  methodLabel,
  recordOutbound,
  recordSharedMailboxCopy,
  registerMetrics,
  routeLabel,
  setOpenStreams,
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

// GH #240. Everything above is inbound: it shows THAT a request was slow or
// failed, never which of the three services this process calls was the reason.
describe("outbound metrics (GH #240)", () => {
  it("counts calls per dependency and outcome", () => {
    const metrics = createMetrics();
    metrics.recordOutbound({ dependency: "stalwart", outcome: "ok", durationMs: 12 });
    metrics.recordOutbound({ dependency: "stalwart", outcome: "ok", durationMs: 8 });
    metrics.recordOutbound({ dependency: "stalwart", outcome: "timeout", durationMs: 10_000 });
    metrics.recordOutbound({ dependency: "oidc", outcome: "error", durationMs: 3 });

    const rendered = metrics.render({});
    expect(sample(rendered, 'cefiro_outbound_requests_total{dependency="stalwart",outcome="ok"}')).toBe("2");
    expect(
      sample(rendered, 'cefiro_outbound_requests_total{dependency="stalwart",outcome="timeout"}'),
    ).toBe("1");
    expect(sample(rendered, 'cefiro_outbound_requests_total{dependency="oidc",outcome="error"}')).toBe("1");
  });

  it("separates a deadline from a refused connection", () => {
    // The distinction on-call needs: `timeout` is a dependency that accepts the
    // connection and does not answer, `error` is one that is not there. The
    // first move is different, so they cannot share a label.
    const metrics = createMetrics();
    metrics.recordOutbound({ dependency: "ai", outcome: "timeout", durationMs: 60_000 });
    const rendered = metrics.render({});
    expect(rendered).toContain('cefiro_outbound_requests_total{dependency="ai",outcome="timeout"} 1');
    expect(rendered).not.toContain('dependency="ai",outcome="error"');
  });

  it("records latency in cumulative buckets reaching the longest deadline", () => {
    // The AI deadline is 60s (core/deadline.ts), so a bucket set ending at 10s
    // would report every AI call as +Inf — the one dependency whose latency
    // actually varies would be the one whose latency is unreadable.
    const metrics = createMetrics();
    metrics.recordOutbound({ dependency: "ai", outcome: "ok", durationMs: 25_000 });
    const rendered = metrics.render({});

    expect(sample(rendered, 'cefiro_outbound_request_duration_seconds_bucket{dependency="ai",le="10"}')).toBe("0");
    expect(sample(rendered, 'cefiro_outbound_request_duration_seconds_bucket{dependency="ai",le="30"}')).toBe("1");
    expect(sample(rendered, 'cefiro_outbound_request_duration_seconds_bucket{dependency="ai",le="60"}')).toBe("1");
    expect(sample(rendered, 'cefiro_outbound_request_duration_seconds_bucket{dependency="ai",le="+Inf"}')).toBe("1");
    expect(sample(rendered, 'cefiro_outbound_request_duration_seconds_count{dependency="ai"}')).toBe("1");
    expect(sample(rendered, 'cefiro_outbound_request_duration_seconds_sum{dependency="ai"}')).toBe("25");
  });

  it("collapses an unknown dependency instead of minting a series for it", () => {
    // Same cardinality guard as the method label: a label value is kept for the
    // life of the process, so the set has to be closed by construction.
    const metrics = createMetrics();
    metrics.recordOutbound({ dependency: "whatever-comes-next", outcome: "ok", durationMs: 1 });
    const rendered = metrics.render({});
    expect(rendered).not.toContain("whatever-comes-next");
    expect(rendered).toContain('cefiro_outbound_requests_total{dependency="other",outcome="ok"} 1');
  });

  it("exposes the open SSE stream count, which no request counter can show", () => {
    // /api/mail/events is a single request that runs for hours, so it does not
    // appear in the inbound counters until it ends.
    const metrics = createMetrics();
    expect(sample(metrics.render({}), "cefiro_sse_streams_open")).toBe("0");
    metrics.setOpenStreams(3);
    expect(sample(metrics.render({}), "cefiro_sse_streams_open")).toBe("3");
    metrics.setOpenStreams(-1);
    expect(sample(metrics.render({}), "cefiro_sse_streams_open")).toBe("0");
  });

  it("declares a type for every family it exposes", () => {
    // A family without a TYPE line is one Prometheus guesses at.
    const rendered = createMetrics().render({});
    expect(rendered).toContain("# TYPE cefiro_outbound_requests_total counter");
    expect(rendered).toContain("# TYPE cefiro_outbound_request_duration_seconds histogram");
    expect(rendered).toContain("# TYPE cefiro_sse_streams_open gauge");
  });
});

// GH #313: the automatic shared-mailbox copy worker runs with no request in
// flight, so nothing above can show whether it is delivering, refusing or
// idle. One counter, three closed outcomes.
describe("shared-mailbox copy metrics (GH #313)", () => {
  it("counts copies by outcome", () => {
    const metrics = createMetrics();
    metrics.recordSharedMailboxCopy("copied");
    metrics.recordSharedMailboxCopy("copied");
    metrics.recordSharedMailboxCopy("failed");
    metrics.recordSharedMailboxCopy("skipped");

    const rendered = metrics.render({});
    expect(sample(rendered, 'cefiro_shared_mailbox_copies_total{result="copied"}')).toBe("2");
    expect(sample(rendered, 'cefiro_shared_mailbox_copies_total{result="failed"}')).toBe("1");
    expect(sample(rendered, 'cefiro_shared_mailbox_copies_total{result="skipped"}')).toBe("1");
    expect(rendered).toContain("# TYPE cefiro_shared_mailbox_copies_total counter");
    expect(rendered).toContain("# HELP cefiro_shared_mailbox_copies_total ");
  });

  it("exposes every outcome at zero from the start, so a dashboard never reads an absent series as no data", () => {
    const rendered = createMetrics().render({});
    expect(sample(rendered, 'cefiro_shared_mailbox_copies_total{result="copied"}')).toBe("0");
    expect(sample(rendered, 'cefiro_shared_mailbox_copies_total{result="failed"}')).toBe("0");
    expect(sample(rendered, 'cefiro_shared_mailbox_copies_total{result="skipped"}')).toBe("0");
  });
});

describe("process-wide reporting handle (GH #240)", () => {
  it("routes observations from far-away modules into the registered registry", () => {
    // core/deadline.ts and modules/mail/streams.ts are imported by half the
    // server and receive no registry; threading one through five constructors
    // to reach a counter would be the worse trade in a process that only ever
    // builds one app.
    const metrics = createMetrics();
    registerMetrics(metrics);

    recordOutbound({ dependency: "stalwart", outcome: "error", durationMs: 4 });
    setOpenStreams(2);
    recordSharedMailboxCopy("copied");

    const rendered = metrics.render({});
    expect(rendered).toContain(
      'cefiro_outbound_requests_total{dependency="stalwart",outcome="error"} 1',
    );
    expect(sample(rendered, "cefiro_sse_streams_open")).toBe("2");
    expect(sample(rendered, 'cefiro_shared_mailbox_copies_total{result="copied"}')).toBe("1");
  });

  it("sends observations to the registry built most recently", () => {
    // Registering is what createApp does, so a second app takes over. It also
    // means a test that builds its own app always starts from clean counters.
    const first = createMetrics();
    registerMetrics(first);
    const second = createMetrics();
    registerMetrics(second);

    recordOutbound({ dependency: "oidc", outcome: "ok", durationMs: 1 });

    expect(second.render({})).toContain('cefiro_outbound_requests_total{dependency="oidc",outcome="ok"} 1');
    expect(first.render({})).not.toContain('dependency="oidc"');
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
