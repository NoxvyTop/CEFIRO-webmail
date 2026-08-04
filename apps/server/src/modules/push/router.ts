import { Hono, type MiddlewareHandler } from "hono";
import { pushSubscriptionSchema, pushUnsubscribeSchema } from "@webmail/shared";
import { errorResponse } from "../../core/error-response";
import { DomainError } from "../../core/errors";
import { createRateLimiter, type RateLimiter } from "../../core/rate-limit";
import { requireSession } from "../auth/middleware";
import type { PushDeps, PushVariables } from "./context";

// Per-user quota for the subscribe/unsubscribe writes. Keyed by userId (not IP)
// so one office behind a NAT is not throttled as a whole, mirroring the AI
// router. Subscribing is a rare, human-driven action (toggling a setting), so a
// modest ceiling is plenty and still caps a scripted client. Status and the
// public-key read are cheap constants and are NOT quota'd.
const PUSH_MAX_REQUESTS_PER_USER = 30;
const PUSH_RATE_WINDOW_MS = 60_000;

/**
 * Fails fast with `push_disabled` when no push client is configured — mirrors
 * requireAiEnabled. The UI hides the opt-in when the feature is off, so this is
 * a defensive backstop for a client that posts anyway.
 */
function requirePushEnabled(deps: PushDeps): MiddlewareHandler<{ Variables: PushVariables }> {
  return async (_c, next) => {
    if (!deps.pushClient) {
      throw new DomainError("push_disabled", 501, "errors.push_disabled");
    }
    await next();
  };
}

/**
 * Per-user quota gate. On over-limit: 429 with Retry-After and the
 * `push_rate_limited` code, refused before the write.
 */
function requirePushQuota(limiter: RateLimiter): MiddlewareHandler<{ Variables: PushVariables }> {
  return async (c, next) => {
    const gate = limiter.check(c.get("user").userId);
    if (!gate.allowed) {
      c.header("Retry-After", String(gate.retryAfterSeconds));
      return errorResponse(c, "push_rate_limited", 429);
    }
    await next();
  };
}

/**
 * Router for the Web Push delivery feature (#294, delivery slice). Session-gated
 * like the mail/ai routers. `enabled` mirrors the software-level gate: the push
 * client is only wired when the VAPID keys are all configured (see index.ts
 * buildPushClient).
 */
export function createPushRouter(deps: PushDeps) {
  const router = new Hono<{ Variables: PushVariables }>();
  const pushRateLimiter =
    deps.pushRateLimiter ??
    createRateLimiter({ limit: PUSH_MAX_REQUESTS_PER_USER, windowMs: PUSH_RATE_WINDOW_MS });
  const quota = requirePushQuota(pushRateLimiter);

  router.use("*", requireSession(deps.sessions));

  // Lets the SPA learn whether push is usable BEFORE offering the opt-in,
  // instead of discovering it from an error. Session-gated like /ai/status; no
  // quota, since it does no work.
  router.get("/status", (c) => c.json({ enabled: deps.pushClient != null }));

  // The public key the browser passes to PushManager.subscribe. Available only
  // when the feature is configured; 404 otherwise, which the SPA reads as "off"
  // (it also gates the whole UI on /status first).
  router.get("/vapid-public-key", (c) => {
    if (!deps.pushClient || !deps.vapidPublicKey) {
      return errorResponse(c, "not_found", 404);
    }
    return c.json({ publicKey: deps.vapidPublicKey });
  });

  // Store (create-or-update by endpoint) a browser PushSubscription for the
  // session user, capturing the User-Agent for the future per-device list.
  router.post("/subscribe", requirePushEnabled(deps), quota, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = pushSubscriptionSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    await deps.pushSubscriptions.upsert({
      userId: c.get("user").userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent: c.req.header("user-agent") ?? null,
    });
    return c.json({ ok: true });
  });

  // Opt out: remove one endpoint, scoped to the session user so a caller can
  // only drop their own device. Not gated on `push_disabled` — cleaning up an
  // old subscription must work even after the feature is turned off.
  router.delete("/subscribe", quota, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = pushUnsubscribeSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    await deps.pushSubscriptions.deleteByUserAndEndpoint(c.get("user").userId, parsed.data.endpoint);
    return c.json({ ok: true });
  });

  return router;
}

export type PushRouter = ReturnType<typeof createPushRouter>;
