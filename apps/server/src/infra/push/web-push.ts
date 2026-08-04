import webpush from "web-push";
import type { PushPayload, PushSender, PushSendResult } from "../../core/push";
import type { StoredPushSubscription } from "../../infra/repos/push-subscriptions";
import { log } from "../../core/logger";

// #294 (delivery slice): the Web Push adapter. It speaks the IETF Web Push
// protocol via the `web-push` library — an encrypted payload to the device's
// push endpoint, authenticated with a VAPID JWT — so the ECDH/HKDF/AES-GCM
// crypto is the library's, never hand-rolled here (verified to run under Bun).

// How long the push service should hold an undelivered notification, in
// seconds. A "new mail" nudge is worthless a day later, so it is not worth
// queueing indefinitely; an hour outlives a brief phone-offline gap without
// piling up stale alerts.
const DEFAULT_TTL_SECONDS = 3600;

// Minimal slice of the `web-push` module this adapter depends on — lets tests
// inject a fake instead of hitting a real push endpoint, the same DI pattern as
// the Anthropic adapter's injectable `client` (infra/ai/anthropic.ts).
export type WebPushLib = {
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
      TTL?: number;
    },
  ): Promise<{ statusCode: number }>;
};

/**
 * A `410 Gone` / `404 Not Found` from the push service means the subscription
 * has expired and will never work again — the one failure the caller must act
 * on by deleting the dead row. `web-push` throws a `WebPushError` carrying the
 * HTTP `statusCode`; anything else is a transient/other failure.
 */
function isExpired(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

export function createWebPushSender(input: {
  publicKey: string;
  privateKey: string;
  subject: string;
  /** Injectable so tests fake the network; defaults to the real library. */
  webpush?: WebPushLib;
}): PushSender {
  const lib = input.webpush ?? (webpush as unknown as WebPushLib);
  // Passed per-call rather than via the library's global `setVapidDetails`, so
  // the adapter holds no process-wide mutable state and stays trivially
  // testable/instantiable more than once.
  const vapidDetails = {
    subject: input.subject,
    publicKey: input.publicKey,
    privateKey: input.privateKey,
  };

  return {
    async send(
      subscription: StoredPushSubscription,
      payload: PushPayload,
    ): Promise<PushSendResult> {
      try {
        await lib.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          { vapidDetails, TTL: DEFAULT_TTL_SECONDS },
        );
        return "sent";
      } catch (error) {
        if (isExpired(error)) return "expired";
        // Never log the endpoint (it identifies the device) or the payload
        // (title/subject) — only the transport failure itself, mirroring the
        // AI adapter's privacy discipline (core/ai.ts).
        log("warn", "push send failed", {
          statusCode: (error as { statusCode?: number } | null)?.statusCode,
          error: error instanceof Error ? error.message : "unknown",
        });
        return "failed";
      }
    },
  };
}
