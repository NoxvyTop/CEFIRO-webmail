import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { InstanceSettingsView } from "@webmail/shared";
import type { InstanceSettingsRepo } from "./infra/repos/instance-settings";
import { logAccess, loggedPath } from "./core/access-log";
import { DEFAULT_TRUSTED_PROXY_HOPS, rateLimitKey } from "./core/client-ip";
import { DEFAULT_MAX_BODY_BYTES } from "./core/config";
import { csrfDecision, logCsrfRefusal } from "./core/csrf";
import { errorResponse } from "./core/error-response";
import { DomainError } from "./core/errors";
import { createHealthProbe, type HealthCheck } from "./core/health";
import { log, withLogContext } from "./core/logger";
import {
  bearerTokenMatches,
  createMetrics,
  PROMETHEUS_CONTENT_TYPE,
  registerMetrics,
  routeLabel,
} from "./core/metrics";
import { createRateLimiter, type RateLimiter } from "./core/rate-limit";

type Env = { Variables: { traceId: string } };

// The one route that must bypass the global body cap: the attachment upload
// streams its body straight to Stalwart (modules/mail/router.ts POST /blobs)
// instead of buffering it via c.req.json(), and legitimate attachments
// routinely exceed the cap — it needs a rate-aware upload budget, not this
// memory-exhaustion guard (GH #195).
const STREAMED_UPLOAD_PATH = "/api/mail/blobs";

// The same route is the only one exempt from the `application/json` rule the
// CSRF middleware enforces (GH #335): it relays whatever the attachment is,
// which is binary by contract. It is NOT exempt from the origin check. Nothing
// else here parses a non-JSON body — the avatar arrives as a data: URL inside
// the profile JSON, so there is no multipart route to exempt.
const BINARY_BODY_PATHS: ReadonlySet<string> = new Set([STREAMED_UPLOAD_PATH]);

// Flood ceiling for the one route that answers without a session (GH #220).
// Deliberately generous: the container's own probe polls twice a minute
// (`HEALTHCHECK --interval=30s`), two orders of magnitude below this, so the
// limit can never be what marks a healthy instance unhealthy. The probe result
// is cached (core/health.ts), so what is left to bound here is only the cost of
// serving the cached line — the same protection the break-glass login path gets.
const HEALTH_MAX_REQUESTS = 60;
const HEALTH_RATE_WINDOW_MS = 60_000;

// Flood ceiling for /metrics (GH #208), in its own bucket rather than sharing
// health's: a scraper hammering one must never be able to spend the budget that
// keeps the orchestrator's readiness poll answering. A Prometheus job scraping
// every 15s costs 4 of these a minute.
const METRICS_MAX_REQUESTS = 60;
const METRICS_RATE_WINDOW_MS = 60_000;

export type { HealthCheck };

export type CreateAppOptions = {
  checks?: Record<string, HealthCheck>;
  /** Per-check budget for /api/health in ms (GH #212). See core/health.ts. */
  healthBudgetMs?: number;
  /** How long a health probe result is reused, in ms (GH #220). */
  healthCacheMs?: number;
  /** Injectable so tests drive a small limit; see core/rate-limit.ts. */
  healthRateLimiter?: RateLimiter;
  /**
   * Bearer token that unlocks /metrics (GH #208); without one the endpoint does
   * not exist. Comes from `config.metricsToken` — i.e. from `METRICS_TOKEN`
   * through the validated schema (GH #259). It used to fall back to reading
   * `process.env.METRICS_TOKEN` here, which meant a misspelled variable name
   * silently produced the same 404 as "metrics off on purpose"; the endpoint is
   * a monitoring contract, so its input belongs in core/config.ts with the rest
   * of them rather than beside LOG_LEVEL's ad-hoc read.
   */
  metricsToken?: string;
  /** Injectable so tests drive a small limit; see core/rate-limit.ts. */
  metricsRateLimiter?: RateLimiter;
  /** Global request-body ceiling in bytes (GH #195). See core/config.ts. */
  maxBodyBytes?: number;
  /**
   * The instance's public URL — `config.appUrl`, i.e. `APP_URL` through the
   * validated schema. Only its ORIGIN is used, and only by the CSRF gate
   * (GH #335, core/csrf.ts). Optional because most tests build an app without
   * a config: with none wired (or an unparseable one), the gate compares
   * against the origin the request was addressed to, which is the same answer
   * for a single-origin deployment and never weaker than no check at all.
   */
  appUrl?: string;
  /**
   * How many proxy hops to trust in `X-Forwarded-For` (GH #238). Keys both
   * ceilings below; see core/client-ip.ts for the attribution rule.
   */
  trustedProxyHops?: number;
  instanceSettings?: InstanceSettingsRepo;
  authRouter?: Hono<any>;
  setupRouter?: Hono<any>;
  mailRouter?: Hono<any>;
  sieveRouter?: Hono<any>;
  adminRouter?: Hono<any>;
  aiRouter?: Hono<any>;
  pushRouter?: Hono<any>;
  profileRouter?: Hono<any>;
  contactsRouter?: Hono<any>;
};

// Default Content-Security-Policy for the self-hosted SPA.
//
// GH #47 verified this against the REAL `vite build` output rather than against
// the dev server, by serving `apps/web/dist` behind these exact headers and
// loading it in a browser. What that measured, directive by directive, is
// recorded below — the point being that "this is what the bundle needs" used to
// be an assumption, and a CSP that is wrong in the tightening direction fails
// silently, at runtime, in production only.
const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // No nonce and no hash because the built HTML has no inline script at all:
  // the theme init runs inside the bundle before React mounts (themeInit.ts,
  // first import of main.tsx). Confirmed against dist/index.html, and now
  // enforced at build time — apps/web/vite.config.ts fails the build if Vite
  // ever emits one, rather than letting the browser discover it.
  //
  // This also covers the pdf.js web worker: `worker-src` falls back to
  // `script-src`, and Vite emits the worker as a same-origin asset
  // (assets/pdf.worker.min-*.mjs), so it constructs under 'self' with no extra
  // directive. pdf.js additionally probes for `eval` (FeatureTest
  // .isEvalSupported) and falls back to its own interpreter when refused, which
  // is why there is deliberately no 'unsafe-eval' here — the one CSP report the
  // production console shows is that probe being turned down, as intended.
  "script-src 'self'",
  // 'unsafe-inline' is load-bearing and cannot be dropped: a `srcdoc` iframe
  // inherits THIS policy, and every rendered email body carries an inline
  // <style> block of its own (the paper background, ink colour and font in
  // reader/EmailBody.tsx) plus whatever inline styles the message itself uses —
  // HTML email is inline styling almost by definition. Measured under
  // `style-src 'self'`: the email iframe's <style> and every style="" attribute
  // inside it stop applying, so mail renders unstyled.
  //
  // Note this is NOT needed for React's own `style={{…}}`, which assigns
  // through the CSSOM rather than writing the attribute as a string and is
  // therefore outside CSP's reach — verified: the logo animations still applied
  // with 'unsafe-inline' removed. The email body is the whole reason.
  "style-src 'self' 'unsafe-inline'",
  // `data:` for inline images (avatars, the seal), `blob:` for the attachment
  // preview object URLs, `https:` for the remote images a reader has opted into
  // per message (reader/sanitize.ts strips them otherwise).
  "img-src 'self' data: blob: https:",
  // The in-app attachment viewer fetches a preview blob and frames it via a
  // same-origin `blob:` object URL (image/pdf only). Without `blob:` here,
  // frame-src falls back to default-src 'self' and the browser blocks the
  // object-URL iframe ("this content is blocked") — reproduced under a
  // tightened policy, which reported exactly that violation. Safe: object URLs
  // are created only from server-verified previewable types, never text/html.
  "frame-src 'self' blob:",
  // The app's own fonts are same-origin assets, so 'self' alone covers the
  // bundle. `data:` is for message content: an email's @font-face can carry the
  // face inline, and a data: URL is inert bytes rather than a fetch to anywhere.
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

// GH #347: browser features this SPA never uses and has no legitimate reason
// to be asked for — camera, microphone, geolocation, payment, and usb — denied
// outright rather than left to their (permissive) per-browser defaults. `()`
// means no origin at all, not even this one, may use the feature: if a
// compromised dependency, or a sanitizer bypass in a rendered email body
// (reader/sanitize.ts), ever tried to invoke one of these, the browser refuses
// before the permission prompt a user might otherwise click through.
const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": DEFAULT_CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  // `preload` (GH #347) opts this origin into browsers' built-in HSTS preload
  // list (hstspreload.org), so the very FIRST connection a browser ever makes
  // to it is already forced to https — without it, HSTS only protects a
  // browser that has already visited this origin over https once before.
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "permissions-policy": PERMISSIONS_POLICY,
};

export function createApp(options: CreateAppOptions = {}) {
  const checks = options.checks ?? {};
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Rate-limit key for the two routes here that carry no session to key on.
  // This used to be a local helper taking the FIRST hop of `x-forwarded-for`,
  // which under an appending proxy is the part the caller wrote — see
  // core/client-ip.ts for why that let one client rotate through unlimited
  // buckets, and why the same helper now serves all five ceilings (GH #238).
  const trustedProxyHops = options.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;
  const metrics = createMetrics();
  // Outbound calls (core/deadline.ts) and open SSE streams (modules/mail/
  // streams.ts) happen far from here and report in through the module-level
  // handle (GH #240).
  registerMetrics(metrics);
  // An empty value counts as unset: an operator who declares METRICS_TOKEN= in
  // a compose file has not configured a token, and must not get an endpoint
  // unlocked by the empty string. core/config.ts already refuses one; this
  // keeps the guarantee for callers that build an app without it (the tests).
  const metricsToken = options.metricsToken?.trim() || undefined;
  // Only the origin of APP_URL matters to the CSRF gate, and an unparseable
  // value degrades to "compare against the request's own origin" rather than
  // refusing every mutation on the instance — core/config.ts already validates
  // the real one as a URL, so this is a guard for callers that build an app by
  // hand, not a licence to misconfigure.
  const expectedOrigin = (() => {
    if (!options.appUrl) return undefined;
    try {
      return new URL(options.appUrl).origin;
    } catch {
      return undefined;
    }
  })();
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    c.set("traceId", traceId);
    c.header("x-trace-id", traceId);
    try {
      // GH #219: every log line written while this request runs — including the
      // ones deep in core/deadline.ts, the JMAP routes, the sieve sync and the
      // AI adapter — carries this traceId, without threading a logger through
      // every signature. See core/logger.ts.
      await withLogContext({ traceId }, () => next());
    } finally {
      // Apply global security headers as defaults only: route-specific headers
      // (e.g. the attachment proxy's `content-security-policy: sandbox`) are set
      // during the handler and must not be clobbered here.
      //
      // In a `finally` (GH #48) so an unwinding request cannot skip them. Hono's
      // compose() happens to catch a thrown handler error at the dispatch level
      // BELOW this middleware and answer it through app.onError, so today the
      // straight-line version would still run — but that is an internal of the
      // router, not a guarantee this app makes. A response that leaves without
      // CSP/HSTS/nosniff because a handler threw is precisely the case where the
      // headers are least affordable to lose, so the guarantee is made here and
      // pinned by the "thrown error" tests in app.test.ts.
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        if (!c.res.headers.has(name)) c.res.headers.set(name, value);
      }
    }
    // The status is known only here, and every response passes through —
    // handler returns, hand-built error envelopes, notFound and onError alike.
    // See core/access-log.ts for the level and path choices.
    const durationMs = Date.now() - startedAt;
    logAccess({
      traceId,
      method: c.req.method,
      path: loggedPath(c.req.matchedRoutes, c.req.path),
      status: c.res.status,
      durationMs,
    });
    // Same single vantage point, aggregated instead of per line (GH #208): the
    // access log answers "what happened to this one request", the counters
    // answer "how many and how slow", which is the question nobody could ask
    // before. Note the route label is NOT loggedPath's — see core/metrics.ts.
    metrics.recordRequest({
      method: c.req.method,
      route: routeLabel(c.req.matchedRoutes),
      status: c.res.status,
      durationMs,
    });
  });

  // Cross-site request forgery gate (GH #335), ahead of the body ceiling and of
  // every router: a forged mutation is refused before a byte of its body is
  // buffered, and before any handler can act on it. The rule, its exemptions and
  // the reasoning are in core/csrf.ts; what lives here is only the wiring.
  //
  // It sits after the trace/security-header middleware so a refusal still gets a
  // traceId and the standard headers, like every other answer this app gives.
  app.use("*", async (c, next) => {
    const decision = csrfDecision(
      {
        method: c.req.method,
        url: c.req.url,
        path: c.req.path,
        header: (name) => c.req.header(name),
        // `raw.body` is null exactly when there is no body to type-check, and
        // reading the property does not consume the stream.
        hasBody: c.req.raw.body !== null,
      },
      expectedOrigin,
      BINARY_BODY_PATHS,
    );
    if (decision.allowed) return next();
    logCsrfRefusal({
      traceId: c.get("traceId"),
      method: c.req.method,
      // Same path rule the access log uses (core/access-log.ts). Routing has not
      // happened yet at this point, so this is the raw path — which is what the
      // access log for this very request will record too, so the two agree.
      route: loggedPath(c.req.matchedRoutes, c.req.path),
      status: decision.status,
      reason: decision.reason,
    });
    return errorResponse(c, decision.code, decision.status);
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

  // Liveness, deliberately separate from the readiness answer below (GH #242).
  //
  // It reports one thing — this process is up and serving HTTP — and it is what
  // the container's own HEALTHCHECK probes. The two questions had been
  // collapsed into `/api/health`, so a Stalwart outage marked the webmail
  // container UNHEALTHY: an orchestrator then restarts (or refuses to start) a
  // process that is working perfectly, serving the SPA and correctly answering
  // 503 on the readiness endpoint. Restarting this container has never fixed a
  // down Postgres or Stalwart, so tying container health to a dependency turns
  // one outage into two. Dependency state stays where a load balancer and an
  // orchestrator's READINESS probe read it: `/api/health`. See
  // docs/OPERATIONS.md and the Dockerfile's HEALTHCHECK.
  //
  // Deliberately UNLIMITED (GH #347). This used to share the readiness
  // ceiling on the theory that "the container probe connects directly (no
  // x-forwarded-for) into a bucket no proxied caller can reach" — but that
  // bucket is UNATTRIBUTED_CLIENT (core/client-ip.ts), which is shared by
  // EVERY request whose X-Forwarded-For chain is shorter than
  // TRUSTED_PROXY_HOPS, not just loopback callers. With TRUSTED_PROXY_HOPS
  // set for a multi-hop topology, a handful of such requests could exhaust
  // that shared bucket and turn the container's own HEALTHCHECK poll into a
  // 429 — marking a perfectly healthy instance unhealthy, i.e. exactly the
  // outage GH #242 split this endpoint to avoid. The endpoint answers a
  // hardcoded constant with no dependency check and no cache lookup (see the
  // "runs no dependency check at all" test below), so there is no cost here
  // for a limiter to protect — removing it is smaller and safer than trying
  // to attribute loopback callers through the Bun server handle. /api/health
  // keeps its limiter: it drives the (cached) health probe and is a heavier
  // response to serve at volume.
  app.get("/api/health/live", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ status: "alive" });
  });

  app.get("/api/health", async (c) => {
    const gate = healthRateLimiter.check(rateLimitKey(c, trustedProxyHops));
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

  // Scrape endpoint (GH #208). Not public, and not under /api: it is an
  // operator surface, not part of the SPA's contract.
  //
  // Authorization is a shared bearer token, opt-in. The three alternatives were
  // weighed and rejected: leaving it public hands anyone the route inventory,
  // the error-rate curve and the moment a dependency goes down — a map of when
  // the service is weakest; putting it behind an admin session means the
  // scraper needs a real user account with a rotating cookie, which no
  // Prometheus deployment does; and network-only restriction is a promise this
  // repository cannot keep, since the deployment topology lives elsewhere
  // (docker-cefiro). A token is checked in constant time (core/metrics.ts) and
  // costs the operator one env var.
  //
  // With no token configured the route is NOT REGISTERED, rather than
  // registered and answering 401. The difference is what an outsider can tell:
  // an unregistered path falls through to the same place every other unknown
  // path does — the SPA's catch-all in production, the 404 envelope otherwise —
  // so an instance that never enabled metrics leaves no evidence that this
  // server has a metrics endpoint at all.
  //
  // Rendering reuses the CACHED health probe, so a scrape can never become the
  // amplification vector against Stalwart that GH #220 closed, and the endpoint
  // carries its own flood ceiling for the same reason /api/health does.
  if (metricsToken) {
    const metricsRateLimiter =
      options.metricsRateLimiter ??
      createRateLimiter({ limit: METRICS_MAX_REQUESTS, windowMs: METRICS_RATE_WINDOW_MS });

    app.get("/metrics", async (c) => {
      // Ahead of the token check: an endpoint that verifies a secret must bound
      // how fast it can be asked to, or it is a guessing oracle.
      const gate = metricsRateLimiter.check(rateLimitKey(c, trustedProxyHops));
      if (!gate.allowed) {
        c.header("Retry-After", String(gate.retryAfterSeconds));
        return errorResponse(c, "rate_limited", 429);
      }
      if (!(await bearerTokenMatches(c.req.header("authorization"), metricsToken))) {
        return errorResponse(c, "unauthorized", 401);
      }
      const { body } = await healthProbe();
      c.header("cache-control", "no-store");
      return c.body(metrics.render(body.checks), 200, {
        "content-type": PROMETHEUS_CONTENT_TYPE,
      });
    });
  }

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
  if (options.pushRouter) app.route("/api/push", options.pushRouter as never);
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
