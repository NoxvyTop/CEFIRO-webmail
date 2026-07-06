import { Hono } from "hono";
import type { HealthResponse } from "@webmail/shared";
import { DomainError } from "./core/errors";
import { log } from "./core/logger";

type Env = { Variables: { traceId: string } };

export function createApp() {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const traceId = crypto.randomUUID();
    c.set("traceId", traceId);
    c.header("x-trace-id", traceId);
    await next();
  });

  app.get("/api/health", (c) => {
    const body: HealthResponse = { status: "ok", checks: {} };
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
        err.httpStatus as 400,
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
