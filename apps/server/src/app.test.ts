import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { apiErrorSchema, healthResponseSchema } from "@webmail/shared";
import { createApp } from "./app";
import { errorResponse } from "./core/error-response";
import { DEFAULT_HEALTH_BUDGET_MS } from "./core/health";
import { log } from "./core/logger";
import { createRateLimiter } from "./core/rate-limit";

type LogLine = Record<string, unknown>;

/**
 * Collects the JSON lines core/logger.ts writes while `run` executes. The
 * logger prints through console.log/warn/error depending on level, so all
 * three are captured and the level is read back off the parsed line.
 */
async function captureLogs(run: () => Response | Promise<Response>): Promise<{
  res: Response;
  lines: LogLine[];
}> {
  const lines: LogLine[] = [];
  const record = (...args: unknown[]) => {
    lines.push(JSON.parse(String(args[0])) as LogLine);
  };
  const spies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
  ];
  try {
    return { res: await run(), lines };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function requestLine(lines: LogLine[]): LogLine {
  const found = lines.filter((line) => line.msg === "request");
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("app", () => {
  it("returns health with a trace header", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-trace-id")).toBeTruthy();
    expect(healthResponseSchema.parse(await res.json()).status).toBe("ok");
  });

  it("sets default security headers on responses", async () => {
    const res = await createApp().request("/api/health");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    // The attachment viewer frames preview blobs via same-origin object URLs.
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'self' blob:");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await createApp().request("/api/nope");
    expect(res.status).toBe(404);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.code).toBe("not_found");
    expect(body.message).toBe("errors.not_found");
  });
});

describe("health readiness (GH #197)", () => {
  it("returns 200 and status ok when every check passes", async () => {
    const app = createApp({
      checks: { postgres: async () => true, stalwart: async () => true },
    });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ postgres: true, stalwart: true });
  });

  it("returns 503 and status degraded when any check fails, so a balancer can drain it", async () => {
    const app = createApp({
      checks: { postgres: async () => true, stalwart: async () => false },
    });
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe("degraded");
    expect(body.checks.stalwart).toBe(false);
  });
});

describe("health budget (GH #212)", () => {
  /** A dependency that is merely slow, not down: it never answers in time. */
  const stalled = () => new Promise<boolean>(() => {});

  it("keeps the whole endpoint inside its budget instead of the sum of the checks", async () => {
    // The bug: checks ran one after another, so two ~10s upstream ceilings
    // added up to ~20s while the container's HEALTHCHECK waits 5s. Two stalled
    // checks must now cost one budget, not two.
    const app = createApp({
      checks: { postgres: stalled, stalwart: stalled },
      healthBudgetMs: 100,
    });

    const startedAt = Date.now();
    const res = await app.request("/api/health");
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect(elapsed).toBeLessThan(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.checks).toEqual({ postgres: false, stalwart: false });
  });

  it("ships a default budget comfortably under the container HEALTHCHECK timeout", () => {
    // Dockerfile: HEALTHCHECK --timeout=5s. The endpoint must answer well
    // inside that even when every dependency is stalled.
    expect(DEFAULT_HEALTH_BUDGET_MS).toBeLessThan(5_000);
  });

  it("counts a check that throws as failed rather than failing the endpoint", async () => {
    const app = createApp({
      checks: {
        postgres: async () => {
          throw new Error("connection reset");
        },
      },
    });
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    expect(healthResponseSchema.parse(await res.json()).checks.postgres).toBe(false);
  });

  it("still reports a slow-but-answering dependency as healthy", async () => {
    const app = createApp({
      checks: {
        stalwart: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)),
      },
      healthBudgetMs: 500,
    });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });
});

describe("health probe caching (GH #220)", () => {
  it("serves N polls from one probe instead of N outbound calls", async () => {
    let probes = 0;
    const app = createApp({
      checks: {
        stalwart: async () => {
          probes += 1;
          return true;
        },
      },
      healthCacheMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      expect((await app.request("/api/health")).status).toBe(200);
    }
    expect(probes).toBe(1);
  });

  it("collapses a concurrent burst arriving on a cold cache into a single probe", async () => {
    let probes = 0;
    const app = createApp({
      checks: {
        stalwart: async () => {
          probes += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        },
      },
      healthCacheMs: 60_000,
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.request("/api/health")),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(probes).toBe(1);
  });

  it("probes again once the cache window has passed", async () => {
    let probes = 0;
    const app = createApp({
      checks: {
        stalwart: async () => {
          probes += 1;
          return true;
        },
      },
      healthCacheMs: 1,
    });

    await app.request("/api/health");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.request("/api/health");
    expect(probes).toBe(2);
  });

  it("marks the answer no-store so nothing in between serves a stale readiness", async () => {
    const res = await createApp().request("/api/health");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("health rate limit (GH #220)", () => {
  function poll(app: ReturnType<typeof createApp>, ip?: string) {
    return app.request("/api/health", { headers: ip ? { "x-forwarded-for": ip } : {} });
  }

  it("returns 429 with Retry-After once a caller exceeds the limit", async () => {
    const app = createApp({
      healthRateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
    });

    expect((await poll(app, "10.0.0.1")).status).toBe(200);
    expect((await poll(app, "10.0.0.1")).status).toBe(200);

    const blocked = await poll(app, "10.0.0.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(apiErrorSchema.parse(await blocked.json()).code).toBe("rate_limited");
  });

  it("keys per caller, so a flood cannot starve the container probe", async () => {
    // The container's own probe connects directly and carries no
    // x-forwarded-for; a proxied flood must not spend its budget.
    const app = createApp({
      healthRateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await poll(app, "10.0.0.1")).status).toBe(200);
    expect((await poll(app, "10.0.0.1")).status).toBe(429);
    expect((await poll(app)).status).toBe(200);
  });
});

describe("metrics endpoint (GH #208)", () => {
  const TOKEN = "scrape-token";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function scrape(app: ReturnType<typeof createApp>, token = TOKEN, ip?: string) {
    return app.request("/metrics", {
      headers: {
        authorization: `Bearer ${token}`,
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
    });
  }

  it("does not exist at all when no token is configured", async () => {
    // The route is not registered, so it answers exactly like any other unknown
    // path — an instance that never enabled metrics must not confirm the
    // endpoint is there, not even by answering 401.
    vi.stubEnv("METRICS_TOKEN", "");
    const app = createApp();
    const res = await app.request("/metrics");
    const unknown = await app.request("/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(res.status).toBe(unknown.status);
    expect(apiErrorSchema.parse(await res.json()).code).toBe(
      apiErrorSchema.parse(await unknown.json()).code,
    );
  });

  it("treats an empty configured token as unset rather than as a valid secret", async () => {
    vi.stubEnv("METRICS_TOKEN", "   ");
    expect((await createApp().request("/metrics")).status).toBe(404);
  });

  it("reads the token from the environment when the caller passes none", async () => {
    vi.stubEnv("METRICS_TOKEN", TOKEN);
    expect((await scrape(createApp())).status).toBe(200);
  });

  it("refuses a scrape with no credentials or the wrong token", async () => {
    const app = createApp({ metricsToken: TOKEN });
    const anonymous = await app.request("/metrics");
    expect(anonymous.status).toBe(401);
    expect(apiErrorSchema.parse(await anonymous.json()).code).toBe("unauthorized");
    expect((await scrape(app, "wrong-token")).status).toBe(401);
  });

  it("serves the Prometheus text format", async () => {
    const app = createApp({ metricsToken: TOKEN });
    const res = await scrape(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("# TYPE cefiro_http_requests_total counter");
  });

  it("counts served requests by route and status", async () => {
    const app = createApp({
      metricsToken: TOKEN,
      mailRouter: new Hono().get("/messages/:id", (c) => c.json({ ok: true })),
    });
    await app.request("/api/mail/messages/m-1");
    await app.request("/api/mail/messages/m-2");

    const body = await (await scrape(app)).text();
    expect(body).toContain(
      'cefiro_http_requests_total{method="GET",route="/api/mail/messages/:id",status="200"} 2',
    );
    expect(body).toContain(
      'cefiro_http_request_duration_seconds_count{method="GET",route="/api/mail/messages/:id"} 2',
    );
  });

  it("never turns a scanned path into a metric label", async () => {
    // Route labels are kept for the life of the process; a per-path series
    // would let anyone grow this endpoint without bound.
    const app = createApp({ metricsToken: TOKEN });
    await app.request("/wp-login.php");
    await app.request("/api/mail/messages/m-secret-id");

    const body = await (await scrape(app)).text();
    expect(body).not.toContain("wp-login");
    expect(body).not.toContain("m-secret-id");
    expect(body).toContain('route="<unmatched>"');
  });

  it("reports dependency state without making a single new outbound call", async () => {
    // The whole point of reusing the cached health probe (GH #220): scraping
    // must not be a way to generate load on Stalwart.
    let probes = 0;
    const app = createApp({
      metricsToken: TOKEN,
      checks: {
        postgres: async () => true,
        stalwart: async () => {
          probes += 1;
          return false;
        },
      },
      healthCacheMs: 60_000,
    });

    await app.request("/api/health");
    for (let i = 0; i < 3; i += 1) await scrape(app);

    expect(probes).toBe(1);
    const body = await (await scrape(app)).text();
    expect(body).toContain('cefiro_dependency_up{dependency="postgres"} 1');
    expect(body).toContain('cefiro_dependency_up{dependency="stalwart"} 0');
  });

  it("returns 429 with Retry-After once a caller exceeds the limit", async () => {
    const app = createApp({
      metricsToken: TOKEN,
      metricsRateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await scrape(app, TOKEN, "10.0.0.1")).status).toBe(200);
    const blocked = await scrape(app, TOKEN, "10.0.0.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("bounds token guessing, refusing a flood before it can check the secret", async () => {
    const app = createApp({
      metricsToken: TOKEN,
      metricsRateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await scrape(app, "guess-1", "10.0.0.2")).status).toBe(401);
    expect((await scrape(app, "guess-2", "10.0.0.2")).status).toBe(429);
  });

  it("keeps its budget separate from the health poll's", async () => {
    // A scraper hammering /metrics must never be able to make the orchestrator's
    // readiness poll start failing.
    const app = createApp({
      metricsToken: TOKEN,
      metricsRateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await scrape(app, TOKEN, "10.0.0.3")).status).toBe(200);
    expect((await scrape(app, TOKEN, "10.0.0.3")).status).toBe(429);
    expect(
      (await app.request("/api/health", { headers: { "x-forwarded-for": "10.0.0.3" } })).status,
    ).toBe(200);
  });
});

describe("global body limit (GH #195)", () => {
  const echoRouter = new Hono()
    .post("/echo", (c) => c.json({ ok: true }))
    .post("/blobs", (c) => c.json({ ok: true }));

  function post(app: ReturnType<typeof createApp>, path: string, bytes: number) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(bytes),
    });
  }

  it("rejects a body over the configured limit with payload_too_large", async () => {
    const app = createApp({ mailRouter: echoRouter, maxBodyBytes: 100 });
    const res = await post(app, "/api/mail/echo", 500);
    expect(res.status).toBe(413);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("payload_too_large");
  });

  it("lets a body within the limit through", async () => {
    const app = createApp({ mailRouter: echoRouter, maxBodyBytes: 1000 });
    const res = await post(app, "/api/mail/echo", 50);
    expect(res.status).toBe(200);
  });

  it("does not cap the streamed attachment upload route (POST /api/mail/blobs)", async () => {
    // /blobs streams straight to Stalwart and legitimately carries multi-MB
    // attachments; the global JSON-body cap must not shadow it.
    const app = createApp({ mailRouter: echoRouter, maxBodyBytes: 100 });
    const res = await post(app, "/api/mail/blobs", 500);
    expect(res.status).toBe(200);
  });
});

describe("access log", () => {
  it("logs one line per response with method, path, status, duration and the trace id", async () => {
    const { res, lines } = await captureLogs(() => createApp().request("/api/health"));
    const line = requestLine(lines);
    expect(line).toMatchObject({
      level: "info",
      method: "GET",
      path: "/api/health",
      status: 200,
      traceId: res.headers.get("x-trace-id"),
    });
    expect(typeof line.durationMs).toBe("number");
  });

  it("logs a client error at warn and a server error at error", async () => {
    const boom = new Hono().get("/boom", () => {
      throw new Error("kaboom");
    });

    const clientError = await captureLogs(() => createApp().request("/api/nope"));
    expect(requestLine(clientError.lines)).toMatchObject({ level: "warn", status: 404 });

    const serverError = await captureLogs(() =>
      createApp({ mailRouter: boom }).request("/api/mail/boom"),
    );
    expect(requestLine(serverError.lines)).toMatchObject({ level: "error", status: 500 });
  });

  it("logs the matched route pattern instead of the concrete ids in the path", async () => {
    const router = new Hono().get("/messages/:id", (c) => c.json({ ok: true }));
    const { lines } = await captureLogs(() =>
      createApp({ mailRouter: router }).request("/api/mail/messages/m-secret-id"),
    );
    const line = requestLine(lines);
    expect(line.path).toBe("/api/mail/messages/:id");
    expect(JSON.stringify(line)).not.toContain("m-secret-id");
  });

  it("still names the endpoint when a guard short-circuits before the handler", async () => {
    const router = new Hono()
      .use("*", async (c) => c.json({ code: "unauthorized" }, 401))
      .get("/messages/:id", (c) => c.json({ ok: true }));
    const { lines } = await captureLogs(() =>
      createApp({ mailRouter: router }).request("/api/mail/messages/m-1"),
    );
    expect(requestLine(lines)).toMatchObject({
      level: "warn",
      status: 401,
      path: "/api/mail/messages/:id",
    });
  });

  it("correlates the error code and the access record by the trace id the client is given", async () => {
    // GH #166: the whole point. A user reports a failure with the traceId from
    // the response body; both the code that was returned and the request that
    // returned it must be findable by searching for exactly that string.
    const router = new Hono().get("/messages/:id", (c) =>
      errorResponse(c, "not_in_trash", 409),
    );
    const { res, lines } = await captureLogs(() =>
      createApp({ mailRouter: router }).request("/api/mail/messages/m-1"),
    );
    const traceId = apiErrorSchema.parse(await res.json()).traceId;
    expect(traceId).toBe(res.headers.get("x-trace-id"));

    const correlated = lines.filter((line) => line.traceId === traceId);
    expect(correlated).toContainEqual(
      expect.objectContaining({ msg: "error response", code: "not_in_trash", status: 409 }),
    );
    expect(correlated).toContainEqual(
      expect.objectContaining({
        msg: "request",
        method: "GET",
        path: "/api/mail/messages/:id",
        status: 409,
      }),
    );
  });

  it("carries the trace id into diagnostic logs written deep inside a handler (GH #219)", async () => {
    // The diagnostic lines that matter (the outbound deadline, the sieve sync,
    // the contacts harvest) are written several layers below the handler and
    // take no logger argument. They must still be findable by the traceId the
    // client was given — including from work that resumes on a later tick.
    const router = new Hono().get("/deep", async (c) => {
      log("warn", "deep diagnostic", { upstream: "stalwart" });
      await new Promise((resolve) => setTimeout(resolve, 1));
      log("error", "after a tick", {});
      return c.json({ ok: true });
    });

    const { res, lines } = await captureLogs(() =>
      createApp({ mailRouter: router }).request("/api/mail/deep"),
    );
    const traceId = res.headers.get("x-trace-id");

    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "deep diagnostic", upstream: "stalwart", traceId }),
    );
    expect(lines).toContainEqual(expect.objectContaining({ msg: "after a tick", traceId }));
  });

  it("falls back to the requested path when nothing matched, without the query string", async () => {
    const { lines } = await captureLogs(() =>
      createApp().request("/api/nope?code=super-secret"),
    );
    const line = requestLine(lines);
    expect(line.path).toBe("/api/nope");
    expect(JSON.stringify(line)).not.toContain("super-secret");
  });
});
