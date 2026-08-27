import { z } from "zod";

// #294 (delivery slice): the request/response contracts for Web Push
// notifications. The push feature is opt-in and inert until VAPID keys are
// configured on the server — exactly like the AI feature (see api/ai.ts) — so
// every one of these shapes is only ever exchanged once the SPA has learned
// from `pushStatusSchema` that push is enabled.

/**
 * A browser `PushSubscription`, as produced by `PushSubscription.toJSON()`
 * (`PushManager.subscribe(...)` output). The server stores `endpoint` (unique),
 * and the two `keys` needed to encrypt a payload for this device.
 *
 * `expirationTime` is part of the browser shape but carries no value for us —
 * it is accepted so a verbatim `subscription.toJSON()` validates, and ignored.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    // The device's P-256 ECDH public key and auth secret, base64url. Never
    // decoded here — the server hands them straight to the `web-push` protocol.
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/**
 * The body of `DELETE /api/push/subscribe`: the endpoint to forget. The server
 * removes it only for the session user (a caller cannot delete someone else's
 * subscription by guessing an endpoint).
 */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>;

/**
 * Whether push is usable on this server, so the SPA can hide the opt-in
 * entirely when it is off (the default). `enabled` mirrors the server's own
 * gate: the push client is only built when the VAPID keys are all configured
 * (see index.ts buildPushClient), the same way `aiStatusSchema` works.
 */
export const pushStatusSchema = z.object({
  enabled: z.boolean(),
});
export type PushStatus = z.infer<typeof pushStatusSchema>;

/**
 * The VAPID public key the SPA needs to pass to `PushManager.subscribe`. Served
 * only when push is configured; unavailable (404) otherwise.
 */
export const pushVapidKeySchema = z.object({
  publicKey: z.string().min(1),
});
export type PushVapidKey = z.infer<typeof pushVapidKeySchema>;
