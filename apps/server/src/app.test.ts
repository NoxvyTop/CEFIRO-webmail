import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { apiErrorSchema, healthResponseSchema } from "@webmail/shared";
import { createApp } from "./app";
import { withDeadlineFetch } from "./core/deadline";
import { errorResponse } from "./core/error-response";
import { DomainError } from "./core/errors";
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

// GH #47. Every directive here was measured against the real `vite build`
// output served behind these exact headers, not against the dev server: the
// bundle was loaded in a browser under this policy (nothing blocked) and again
// under a tightened one, to find out which parts are load-bearing rather than
// assumed. These assertions record that measurement, because a CSP that is
// wrong in the tightening direction breaks silently, at runtime, on the
// production build only — which is the failure mode this issue is about.
describe("the deployed Content-Security-Policy (GH #47)", () => {
  async function policy(): Promise<string> {
    const res = await createApp().request("/api/health");
    return res.headers.get("content-security-policy") ?? "";
  }

  it("never relaxes script execution", async () => {
    const csp = await policy();
    // The built index.html carries no inline script (apps/web/vite.config.ts
    // fails the build if that changes), so neither of these is ever needed.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("keeps the inline styles the email body cannot render without", async () => {
    // A srcdoc iframe inherits this policy, and every message body carries its
    // own <style> plus the message's inline styles. Measured: under `style-src
    // 'self'` the whole email renders unstyled.
    expect(await policy()).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("allows the attachment viewer's blob: object-URL iframe", async () => {
    // Measured under `frame-src 'self'`: the browser reports a frame-src
    // violation for `blob` and the preview does not render.
    expect(await policy()).toContain("frame-src 'self' blob:");
  });

  it("still pins everything a self-hosted SPA has no reason to allow", async () => {
    const csp = await policy();
    for (const directive of [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "connect-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});

// GH #48. The headers were applied only after `await next()` returned, so the
// coverage depended on a thrown handler error unwinding back through this
// middleware — which is a detail of the router, not of this app. The three
// answers a request can end on (handler return, thrown DomainError, thrown
// anything else) must carry the same headers, or a caller can tell which one it
// hit from the response envelope alone.
describe("security headers on error responses (GH #48)", () => {
  function expectSecurityHeaders(res: Response) {
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  }

  it("sets them on a DomainError answered by onError", async () => {
    const router = new Hono().get("/boom", () => {
      throw new DomainError("not_in_trash", 409, "errors.not_in_trash");
    });

    const res = await createApp({ mailRouter: router }).request("/api/mail/boom");

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("not_in_trash");
    expectSecurityHeaders(res);
  });

  it("sets them on the 500 an unhandled error is turned into", async () => {
    const router = new Hono().get("/boom", () => {
      throw new Error("something nobody mapped");
    });

    // The unhandled branch of app.onError writes an `error` line; swallow it so
    // the deliberate failure does not look like a broken run.
    const { res } = await captureLogs(() =>
      createApp({ mailRouter: router }).request("/api/mail/boom"),
    );

    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("internal");
    expectSecurityHeaders(res);
  });

  it("sets them on the notFound envelope", async () => {
    expectSecurityHeaders(await createApp().request("/api/nope"));
  });

  it("leaves a route's own security header alone rather than clobbering it", async () => {
    // The attachment proxy answers with `content-security-policy: sandbox`;
    // these are defaults, not an override.
    const router = new Hono().get("/blob", (c) => {
      c.header("content-security-policy", "sandbox");
      return c.body("bytes", 200);
    });

    const res = await createApp({ mailRouter: router }).request("/api/mail/blob");

    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
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
    //
    // Measured with fake timers, not the wall clock. The first version timed
    // a real request and asserted `elapsed < 2 × budget`; on a shared CI
    // runner one scheduling hiccup turned 100ms into 317ms and failed the
    // main pipeline over a suite that was correct. The invariant is about
    // WHEN the timers fire, so that is what gets asserted: after exactly one
    // budget the response must already be settled. With sequential checks the
    // second timer would only be armed once the first expired, and the
    // request would still be pending here.
    vi.useFakeTimers();
    try {
      const app = createApp({
        checks: { postgres: stalled, stalwart: stalled },
        healthBudgetMs: 100,
      });

      let settled = false;
      // Hono types `app.request` as `Response | Promise<Response>`; wrap it so
      // the settle probe is a real promise chain either way.
      const pending = Promise.resolve(app.request("/api/health")).then((res: Response) => {
        settled = true;
        return res;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);

      const res = await pending;
      expect(res.status).toBe(503);
      const body = healthResponseSchema.parse(await res.json());
      expect(body.checks).toEqual({ postgres: false, stalwart: false });
    } finally {
      vi.useRealTimers();
    }
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

  it("cancels a check that overruns instead of just abandoning it (GH #242)", async () => {
    // The defect: the probe stopped WAITING at its budget but the check kept
    // running to its own upstream deadline (~10s for Stalwart), so every
    // cold-cache poll left seconds of outbound work behind an answer that had
    // already been sent — against a dependency that is by hypothesis struggling.
    let observed: AbortSignal | undefined;
    const app = createApp({
      checks: {
        stalwart: (signal) => {
          observed = signal;
          return new Promise<boolean>(() => {});
        },
      },
      healthBudgetMs: 50,
    });

    expect((await app.request("/api/health")).status).toBe(503);
    expect(observed?.aborted).toBe(true);
  });

  it("cancels a check that finished too, so nothing is left holding the signal", async () => {
    let observed: AbortSignal | undefined;
    const app = createApp({
      checks: {
        postgres: async (signal) => {
          observed = signal;
          return true;
        },
      },
    });

    expect((await app.request("/api/health")).status).toBe(200);
    expect(observed?.aborted).toBe(true);
  });
});

// GH #242. Liveness and readiness are two questions, and collapsing them meant
// a Stalwart outage marked this container unhealthy — so Swarm restarted a
// process that was working, and `depends_on: service_healthy` refused to start
// what waited on it. Restarting this container has never fixed a down
// dependency.
describe("liveness endpoint (GH #242)", () => {
  it("answers 200 while the process is serving", async () => {
    const res = await createApp().request("/api/health/live");
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toEqual({ status: "alive" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("stays 200 with every dependency down, while readiness reports 503", async () => {
    // The whole point of the split: the container is alive and serving the SPA;
    // it is the DEPENDENCY that is unavailable, and that is readiness' answer.
    const app = createApp({ checks: { postgres: async () => false } });
    expect((await app.request("/api/health/live")).status).toBe(200);
    expect((await app.request("/api/health")).status).toBe(503);
  });

  it("runs no dependency check at all", async () => {
    // It must not become a second way to generate load on Stalwart, and it must
    // answer even when every probe is stalled.
    let probes = 0;
    const app = createApp({
      checks: {
        stalwart: () => {
          probes += 1;
          return new Promise<boolean>(() => {});
        },
      },
      healthBudgetMs: 5_000,
    });

    const startedAt = Date.now();
    expect((await app.request("/api/health/live")).status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(probes).toBe(0);
  });

  // GH #347: with TRUSTED_PROXY_HOPS=2 (or any operator whose chain is longer
  // than one hop), a request whose X-Forwarded-For chain is SHORTER than the
  // declared hop count cannot be attributed and fell into UNATTRIBUTED_CLIENT
  // — the exact bucket the container's own HEALTHCHECK uses, since it connects
  // on loopback with no X-Forwarded-For at all. A handful of such requests
  // could exhaust the shared bucket and turn the healthcheck's own poll into a
  // 429, marking a perfectly healthy container unhealthy. The endpoint answers
  // a hardcoded constant with no dependency check and no cache lookup, so
  // rate-limiting it protects nothing — the fix removes the limiter here
  // entirely rather than trying to attribute loopback callers.
  it("is never rate-limited, since it does no work worth protecting (GH #347)", async () => {
    const app = createApp({
      healthRateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    for (let i = 0; i < 5; i += 1) {
      expect((await app.request("/api/health/live")).status).toBe(200);
    }
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
    expect((await createApp({ metricsToken: "   " }).request("/metrics")).status).toBe(404);
  });

  it("never reads the token from the environment behind the caller's back (GH #259)", async () => {
    // The token arrives through core/config.ts now. Reading process.env here as
    // a fallback meant a misspelled variable name produced a 404 that looked
    // exactly like "metrics deliberately off", so monitoring could disappear
    // with nothing to distinguish the two.
    vi.stubEnv("METRICS_TOKEN", TOKEN);
    expect((await scrape(createApp())).status).toBe(404);
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

  it("reports outbound calls made anywhere in the process (GH #240)", async () => {
    // The gap this closes: the counters above show THAT a request failed, never
    // which dependency was the reason. Both calls below go through the same
    // wrapper the JMAP client, the OIDC client and the AI adapters use, which
    // is why instrumenting one file covers every outbound call there is.
    const app = createApp({ metricsToken: TOKEN });

    const answering = (async () => new Response("{}")) as unknown as typeof fetch;
    const reachable = withDeadlineFetch(answering, "stalwart", 1_000);
    await reachable("https://mail.test/.well-known/jmap");

    // Accepts the connection and never answers — the case the deadline exists
    // for, and the one that must not be labelled the same as "refused".
    const mute = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const silent = withDeadlineFetch(mute, "oidc", 10);
    await expect(silent("https://auth.test/.well-known/openid-configuration")).rejects.toThrow();

    const body = await (await scrape(app)).text();
    expect(body).toContain('cefiro_outbound_requests_total{dependency="stalwart",outcome="ok"} 1');
    // A deadline, not a refused connection — the distinction that decides the
    // first move at 3am, and the only place able to draw it.
    expect(body).toContain('cefiro_outbound_requests_total{dependency="oidc",outcome="timeout"} 1');
    expect(body).toContain('cefiro_outbound_request_duration_seconds_count{dependency="stalwart"} 1');
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
      // Set here rather than by importing the browser seam (src/test/browser-app
      // .ts) the other suites use: this file tests createApp itself, so its apps
      // stay the real ones. The header is what a browser sends (GH #335).
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
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
