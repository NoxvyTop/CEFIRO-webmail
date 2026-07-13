import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HealthResponse } from "@webmail/shared";
import { DomainError } from "./core/errors";
import { log } from "./core/logger";

type Env = { Variables: { traceId: string } };

export type HealthCheck = () => Promise<boolean>;

export type CreateAppOptions = {
  checks?: Record<string, HealthCheck>;
  authRouter?: Hono<any>;
  setupRouter?: Hono<any>;
  mailRouter?: Hono<any>;
  sieveRouter?: Hono<any>;
  adminRouter?: Hono<any>;
};

// Default Content-Security-Policy for the self-hosted SPA. The theme
// pre-paint inline script is intentionally not allowlisted: it is a
// progressive enhancement wrapped in try/catch and the SPA re-applies the
// persisted theme on mount, so blocking it under `script-src 'self'` does
// not break the app. Email bodies render in a sandboxed srcdoc iframe and
// opted-in remote images need `img-src ... https:`.
const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": DEFAULT_CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

export function createApp(options: CreateAppOptions = {}) {
  const checks = options.checks ?? {};
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const traceId = crypto.randomUUID();
    c.set("traceId", traceId);
    c.header("x-trace-id", traceId);
    await next();
    // Apply global security headers as defaults only: route-specific headers
    // (e.g. the attachment proxy's `content-security-policy: sandbox`) are set
    // during the handler and must not be clobbered here.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
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

  if (options.authRouter) app.route("/api/auth", options.authRouter as never);
  if (options.setupRouter) app.route("/api/setup", options.setupRouter as never);
  if (options.mailRouter) app.route("/api/mail", options.mailRouter as never);
  if (options.sieveRouter) app.route("/api/mail", options.sieveRouter as never);
  if (options.adminRouter) app.route("/api/admin", options.adminRouter as never);

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
