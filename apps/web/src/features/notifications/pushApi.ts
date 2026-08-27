import {
  pushStatusSchema,
  pushSubscriptionSchema,
  pushVapidKeySchema,
  type PushSubscriptionInput,
} from "@webmail/shared";
import { MailApiError } from "../mailbox/api";

// #294 (delivery slice): the SPA's client for the push endpoints. Mirrors
// features/composer/aiApi.ts — a `fetch*Status` that degrades to the safe
// "off" value on any error, and mutation helpers that throw a MailApiError
// carrying the envelope code.

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Whether push is enabled on this server, so the SPA can hide the opt-in
 * entirely when it is off (the default). Any non-ok response (a 401 before the
 * session is up, a 5xx, an offline fetch) resolves to `false` — the safe
 * default that matches push being off by default. Mirrors fetchAiStatus.
 */
export async function fetchPushStatus(): Promise<boolean> {
  try {
    const res = await fetch("/api/push/status");
    if (!res.ok) return false;
    return pushStatusSchema.parse(await res.json()).enabled;
  } catch {
    return false;
  }
}

/**
 * The VAPID public key the browser needs to subscribe. Resolves to null when
 * push is unconfigured (404) or on any error, so the caller treats it the same
 * as "not available".
 */
export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/push/vapid-public-key");
    if (!res.ok) return null;
    return pushVapidKeySchema.parse(await res.json()).publicKey;
  } catch {
    return null;
  }
}

/** Stores a browser PushSubscription for the session user. */
export async function subscribePush(subscription: PushSubscriptionInput): Promise<void> {
  const res = await fetch(
    "/api/push/subscribe",
    jsonRequest("POST", pushSubscriptionSchema.parse(subscription)),
  );
  if (!res.ok) return parseError(res);
}

/** Removes the session user's subscription for one endpoint (opt-out). */
export async function unsubscribePush(endpoint: string): Promise<void> {
  const res = await fetch("/api/push/subscribe", jsonRequest("DELETE", { endpoint }));
  if (!res.ok) return parseError(res);
}
