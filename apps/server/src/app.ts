import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HealthResponse, InstanceSettingsView } from "@webmail/shared";
import type { InstanceSettingsRepo } from "./infra/repos/instance-settings";
import { logAccess, loggedPath } from "./core/access-log";
import { errorResponse } from "./core/error-response";
import { DomainError } from "./core/errors";
import { log } from "./core/logger";

type Env = { Variables: { traceId: string } };

export type HealthCheck = () => Promise<boolean>;

export type CreateAppOptions = {
  checks?: Record<string, HealthCheck>;
  instanceSettings?: InstanceSettingsRepo;
  authRouter?: Hono<any>;
  setupRouter?: Hono<any>;
  mailRouter?: Hono<any>;
  sieveRouter?: Hono<any>;
  adminRouter?: Hono<any>;
  aiRouter?: Hono<any>;
  profileRouter?: Hono<any>;
  contactsRouter?: Hono<any>;
};

// Default Content-Security-Policy for the self-hosted SPA. There are no
// inline scripts: the theme init runs in the bundle before React mounts
// (themeInit.ts, first import of main.tsx), so `script-src 'self'` needs no
// allowlist. Email bodies render in a sandboxed srcdoc iframe and opted-in
// remote images need `img-src ... https:`.
const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  // The in-app attachment viewer fetches a preview blob and frames it via a
  // same-origin `blob:` object URL (image/pdf only). Without `blob:` here,
  // frame-src falls back to default-src 'self' and the browser blocks the
  // object-URL iframe ("this content is blocked"). Safe: object URLs are
  // created only from server-verified previewable types, never text/html.
  "frame-src 'self' blob:",
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
    const startedAt = Date.now();
    c.set("traceId", traceId);
    c.header("x-trace-id", traceId);
    await next();
    // Apply global security headers as defaults only: route-specific headers
    // (e.g. the attachment proxy's `content-security-policy: sandbox`) are set
    // during the handler and must not be clobbered here.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
    // The status is known only here, and every response passes through —
    // handler returns, hand-built error envelopes, notFound and onError alike.
    // See core/access-log.ts for the level and path choices.
    logAccess({
      traceId,
      method: c.req.method,
      path: loggedPath(c.req.matchedRoutes, c.req.path),
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    });
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

  // Public: the sent-with-footer flag is non-sensitive instance branding
  // (unlike the rest of instance/admin config), so the reader can read it
  // without a session. Defaults to disabled when no repo is wired (e.g. in
  // tests that construct createApp() without a database).
  app.get("/api/instance", async (c) => {
    const settings = options.instanceSettings
      ? await options.instanceSettings.get()
      : { sentWithFooterEnabled: false };
    const body: InstanceSettingsView = { sentWithFooter: settings.sentWithFooterEnabled };
    return c.json(body);
  });

  if (options.authRouter) app.route("/api/auth", options.authRouter as never);
  if (options.setupRouter) app.route("/api/setup", options.setupRouter as never);
  if (options.mailRouter) app.route("/api/mail", options.mailRouter as never);
  if (options.sieveRouter) app.route("/api/mail", options.sieveRouter as never);
  if (options.adminRouter) app.route("/api/admin", options.adminRouter as never);
  if (options.aiRouter) app.route("/api/mail", options.aiRouter as never);
  if (options.profileRouter) app.route("/api/profile", options.profileRouter as never);
  if (options.contactsRouter) app.route("/api/mail", options.contactsRouter as never);

  app.notFound((c) => errorResponse(c, "not_found", 404));

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
