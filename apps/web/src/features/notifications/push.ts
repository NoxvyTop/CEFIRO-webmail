import type { PushSubscriptionInput } from "@webmail/shared";
import { fetchVapidPublicKey, subscribePush, unsubscribePush } from "./pushApi";

// #294 (delivery slice): the browser-side orchestration of Web Push — feature
// detection, service-worker registration, and the subscribe/unsubscribe dance
// that PushManager + the API together require. Kept out of the component so the
// steps are unit-testable with mocked browser globals.

const SERVICE_WORKER_URL = "/sw.js";

/**
 * Whether this browser can do Web Push at all. Checked before anything is
 * offered — an iOS Safari without the APIs, or a non-secure context, simply
 * gets no opt-in.
 */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * base64url VAPID public key → the `Uint8Array` `PushManager.subscribe` wants
 * as `applicationServerKey`. The standard conversion: restore base64 padding
 * and the `+`/`/` alphabet, then decode byte by byte.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Register the service worker. Called at app bootstrap (main.tsx) and safe to
 * call again before subscribing — registration is idempotent. Failures are
 * swallowed: the app works without push, so a registration error must not be
 * fatal at boot.
 */
export async function registerPushServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch {
    // non-fatal — push simply stays unavailable on this load
  }
}

/** The current push subscription for this device, or null if none/unsupported. */
export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Re-announce this device's existing subscription to the server, and report
 * whether the device has one at all (GH #337).
 *
 * The settings panel used to read the browser alone: a `PushSubscription`
 * object was taken as proof the server would push here. It is not — the row
 * can be gone (pruned after a `410`, lost with a restore, dropped when the
 * endpoint was re-pointed at another user) while the browser still holds a
 * perfectly valid subscription, and the user is then shown "enabled on this
 * device" for a device that will never be pushed to again.
 *
 * `POST /api/push/subscribe` is an upsert by endpoint, so re-posting on load is
 * idempotent and cheap. A failed POST is swallowed on purpose: the device IS
 * subscribed in the browser, and saying otherwise because the network blinked
 * would ask the user to re-grant a permission they already gave.
 */
export async function resyncPushSubscription(): Promise<boolean> {
  const subscription = await getExistingPushSubscription();
  if (!subscription) return false;
  try {
    await subscribePush(subscription.toJSON() as PushSubscriptionInput);
  } catch {
    // non-fatal — the browser subscription stands whatever the server said
  }
  return true;
}

export type EnablePushOutcome = "subscribed" | "denied" | "unsupported" | "unavailable";

/**
 * The full opt-in, driven by an explicit user gesture (never on load):
 * fetch the VAPID key, request Notification permission, register+await the
 * service worker, subscribe, and store the subscription on the server.
 *
 * Returns why it stopped rather than throwing for the expected outcomes:
 * `denied` (user refused permission), `unsupported` (no APIs), `unavailable`
 * (server has no key). A genuine failure of the POST still throws.
 */
export async function enablePush(): Promise<EnablePushOutcome> {
  if (!isPushSupported()) return "unsupported";

  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) return "unavailable";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await subscribePush(subscription.toJSON() as PushSubscriptionInput);
  return "subscribed";
}

/**
 * The opt-out: drop the browser subscription and tell the server to forget it.
 * A no-op when there is nothing subscribed.
 */
export async function disablePush(): Promise<void> {
  const subscription = await getExistingPushSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await unsubscribePush(endpoint);
}
