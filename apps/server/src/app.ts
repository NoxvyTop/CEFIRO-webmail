import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { InstanceSettingsView } from "@webmail/shared";
import type { InstanceSettingsRepo } from "./infra/repos/instance-settings";
import { logAccess, loggedPath } from "./core/access-log";
import { DEFAULT_MAX_BODY_BYTES } from "./core/config";
import { errorResponse } from "./core/error-response";
import { DomainError } from "./core/errors";
import { createHealthProbe, type HealthCheck } from "./core/health";
import { log, withLogContext } from "./core/logger";
import { createRateLimiter, type RateLimiter } from "./core/rate-limit";

type Env = { Variables: { traceId: string } };

// The one route that must bypass the global body cap: the attachment upload
// streams its body straight to Stalwart (modules/mail/router.ts POST /blobs)
// instead of buffering it via c.req.json(), and legitimate attachments
// routinely exceed the cap — it needs a rate-aware upload budget, not this
// memory-exhaustion guard (GH #195).
const STREAMED_UPLOAD_PATH = "/api/mail/blobs";

// Flood ceiling for the one route that answers without a session (GH #220).
// Deliberately generous: the container's own probe polls twice a minute
// (`HEALTHCHECK --interval=30s`), two orders of magnitude below this, so the
// limit can never be what marks a healthy instance unhealthy. The probe result
// is cached (core/health.ts), so what is left to bound here is only the cost of
// serving the cached line — the same protection the break-glass login path gets.
const HEALTH_MAX_REQUESTS = 60;
const HEALTH_RATE_WINDOW_MS = 60_000;

export type { HealthCheck };

export type CreateAppOptions = {
  checks?: Record<string, HealthCheck>;
  /** Per-check budget for /api/health in ms (GH #212). See core/health.ts. */
  healthBudgetMs?: number;
  /** How long a health probe result is reused, in ms (GH #220). */
  healthCacheMs?: number;
  /** Injectable so tests drive a small limit; see core/rate-limit.ts. */
  healthRateLimiter?: RateLimiter;
  /** Global request-body ceiling in bytes (GH #195). See core/config.ts. */
  maxBodyBytes?: number;
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

/**
 * Rate-limit key for a request that carries no session to key on. Takes the
 * first hop of `x-forwarded-for` — the same identifier the break-glass login
 * paths use — and falls back to one shared bucket for a direct connection,
 * which behind a reverse proxy is only ever the container's own probe.
 */
function clientKey(forwardedFor: string | undefined): string {
  return forwardedFor?.split(",")[0]?.trim() || "direct";
}

export function createApp(options: CreateAppOptions = {}) {
  const checks = options.checks ?? {};
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    c.set("traceId", traceId);
    c.header("x-trace-id", traceId);
    // GH #219: every log line written while this request runs — including the
    // ones deep in core/deadline.ts, the JMAP routes, the sieve sync and the AI
    // adapter — carries this traceId, without threading a logger through every
    // signature. See core/logger.ts.
    await withLogContext({ traceId }, () => next());
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

  // Global request-body ceiling (GH #195), ahead of every router: without it,
  // the send/drafts/signatures/filters/sso/preferences handlers buffered an
  // unbounded c.req.json() — a memory-exhaustion lever for any authenticated
  // client. The streamed attachment upload is the one exception (see above).
  const globalBodyLimit = bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => errorResponse(c, "payload_too_large", 413),
  });
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" && c.req.path === STREAMED_UPLOAD_PATH) return next();
    return globalBodyLimit(c, next);
  });

  // Checks in parallel under their own budget (GH #212), result cached and
  // de-duplicated so N polls are not N outbound probes (GH #220).
  const healthProbe = createHealthProbe({
    checks,
    budgetMs: options.healthBudgetMs,
    cacheMs: options.healthCacheMs,
  });
  const healthRateLimiter =
    options.healthRateLimiter ??
    createRateLimiter({ limit: HEALTH_MAX_REQUESTS, windowMs: HEALTH_RATE_WINDOW_MS });

  app.get("/api/health", async (c) => {
    const gate = healthRateLimiter.check(clientKey(c.req.header("x-forwarded-for")));
    if (!gate.allowed) {
      c.header("Retry-After", String(gate.retryAfterSeconds));
      return errorResponse(c, "rate_limited", 429);
    }
    const { body, healthy } = await healthProbe();
    // A readiness answer is a point-in-time fact about THIS instance; nothing
    // between here and the poller may serve a stale one on our behalf.
    c.header("cache-control", "no-store");
    // Readiness, not liveness (GH #197): a degraded instance returns 503 so a
    // load balancer / orchestrator drains it from rotation, while a healthy one
    // returns 200. One endpoint rather than split liveness/readiness — this is a
    // single self-hosted container, and restarting the process cannot fix a down
    // Postgres or Stalwart, so a readiness signal is what on-call and the LB need.
    return c.json(body, healthy ? 200 : 503);
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
