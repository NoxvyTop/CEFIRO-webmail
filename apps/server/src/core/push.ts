/**
 * Port for the Web Push delivery feature (#294, delivery slice). The adapter
 * lives in `infra/push/` and implements this interface with the `web-push`
 * protocol; the router never talks to that library directly.
 *
 * Same "null means not configured" convention as `AiClient` (core/ai.ts): when
 * no VAPID keys are set, `buildPushClient` (index.ts) returns null, the router
 * reports `enabled: false`, and nothing is ever sent.
 *
 * Privacy discipline (non-negotiable): the payload NEVER carries a message
 * body. Title + a short body (sender name / truncated subject / a generic
 * count) and an optional target id are all a notification is allowed to hold —
 * the service worker shows exactly what the push contains and fetches nothing.
 */

import type { StoredPushSubscription } from "../infra/repos/push-subscriptions";

/**
 * What a single push is allowed to say. There is deliberately no `data`/`html`
 * escape hatch and no field that could hold the email body — the type is the
 * privacy contract.
 */
export type PushPayload = {
  /** Short, shown as the notification title (e.g. the sender display name). */
  title: string;
  /** Short, shown as the notification body (e.g. a truncated subject). */
  body: string;
  /**
   * Opaque id the service worker uses to open the right screen on click (a
   * thread id). Never displayed, never sensitive.
   */
  targetId?: string;
  /**
   * The JMAP account `targetId` lives in, when that is NOT the user's own —
   * i.e. a shared mailbox (GH #337). The service worker appends it to the URL
   * it opens, because a shared thread id does not resolve in the personal view.
   * Omitted for personal mail, so the common case names no account at all.
   */
  accountId?: string;
};

/**
 * Outcome of one `send`. `expired` is the signal the caller acts on: the push
 * service returned `410 Gone`/`404`, so the subscription is dead and the caller
 * must delete it (repo.deleteByEndpoint). `sent` and `failed` need no cleanup —
 * a `failed` is a transient/other error worth logging, not a reason to forget a
 * still-valid device.
 */
export type PushSendResult = "sent" | "expired" | "failed";

export type PushSender = {
  /**
   * Encrypts `payload` for `subscription` and delivers it to the device's push
   * endpoint. Resolves to a `PushSendResult`; never throws for an ordinary
   * delivery failure (that is what `failed` is for).
   */
  send(subscription: StoredPushSubscription, payload: PushPayload): Promise<PushSendResult>;
};
