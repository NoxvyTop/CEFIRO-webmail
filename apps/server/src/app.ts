import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HealthResponse } from "@webmail/shared";
import { DomainError } from "./core/errors";
import { log } from "./core/logger";

type Env = { Variables: { traceId: string } };

export type HealthCheck = () => Promise<boolean>;

export function createApp(checks: Record<string, HealthCheck> = {}) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const traceId = crypto.randomUUID();
    c.set("traceId", traceId);
    c.header("x-trace-id", traceId);
    await next();
  });

  app.get("/api/health", async (c) => {
    const results: Record<string, boolean> = {};
    for (const [name, check] of Object.entries(checks)) {
      results[name] = await check();
    }
    const body: HealthResponse = {
      status: Object.values(results).every(Boolean) ? "ok" : "degraded",
      checks: results,
    };
    return c.json(body);
  });

  app.notFound((c) =>
    c.json(
      { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
      404,
    ),
  );

  app.onError((err, c) => {
    const traceId = c.get("traceId") ?? "unknown";
    if (err instanceof DomainError) {
      log("warn", "domain error", { traceId, code: err.code });
      return c.json(
        { code: err.code, message: err.messageKey, traceId },
        err.httpStatus as ContentfulStatusCode,
      );
    }
    log("error", "unhandled error", { traceId, error: String(err) });
    return c.json(
      { code: "internal", message: "errors.internal", traceId },
      500,
    );
  });

  return app;
}
