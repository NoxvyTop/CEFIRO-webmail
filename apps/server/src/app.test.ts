import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { apiErrorSchema, healthResponseSchema } from "@webmail/shared";
import { createApp } from "./app";
import { errorResponse } from "./core/error-response";

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

  it("falls back to the requested path when nothing matched, without the query string", async () => {
    const { lines } = await captureLogs(() =>
      createApp().request("/api/nope?code=super-secret"),
    );
    const line = requestLine(lines);
    expect(line.path).toBe("/api/nope");
    expect(JSON.stringify(line)).not.toContain("super-secret");
  });
});
