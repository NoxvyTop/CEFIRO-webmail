import { describe, expect, it, vi } from "vitest";
import { createWebPushSender, type WebPushLib } from "./web-push";
import type { StoredPushSubscription } from "../../infra/repos/push-subscriptions";

const subscription: StoredPushSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  p256dh: "device-p256dh",
  auth: "device-auth",
};

const vapid = {
  publicKey: "BPublicKey",
  privateKey: "PrivateKey",
  subject: "mailto:ops@noxvytop.com",
};

/** A WebPushError-shaped rejection carrying an HTTP statusCode. */
function pushError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`push service returned ${statusCode}`), { statusCode });
}

describe("web-push adapter", () => {
  it("encrypts the payload and calls sendNotification with the VAPID details, reporting 'sent'", async () => {
    const sendNotification = vi.fn<WebPushLib["sendNotification"]>(async () => ({ statusCode: 201 }));
    const lib: WebPushLib = { sendNotification };
    const sender = createWebPushSender({ ...vapid, webpush: lib });

    const result = await sender.send(subscription, { title: "Ana", body: "Asunto", targetId: "t1" });

    expect(result).toBe("sent");
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [sub, payload, options] = sendNotification.mock.calls[0]!;
    expect(sub).toEqual({
      endpoint: subscription.endpoint,
      keys: { p256dh: "device-p256dh", auth: "device-auth" },
    });
    // The payload is JSON — title/body/targetId only, never a message body.
    expect(JSON.parse(payload)).toEqual({ title: "Ana", body: "Asunto", targetId: "t1" });
    expect(options.vapidDetails).toEqual(vapid);
    expect(options.TTL).toBeGreaterThan(0);
  });

  it("signals 'expired' on a 410 Gone so the caller deletes the dead subscription", async () => {
    const lib: WebPushLib = {
      sendNotification: vi.fn(async () => {
        throw pushError(410);
      }),
    };
    const sender = createWebPushSender({ ...vapid, webpush: lib });
    expect(await sender.send(subscription, { title: "t", body: "b" })).toBe("expired");
  });

  it("signals 'expired' on a 404 Not Found too", async () => {
    const lib: WebPushLib = {
      sendNotification: vi.fn(async () => {
        throw pushError(404);
      }),
    };
    const sender = createWebPushSender({ ...vapid, webpush: lib });
    expect(await sender.send(subscription, { title: "t", body: "b" })).toBe("expired");
  });

  it("reports 'failed' (not 'expired') on any other push-service error", async () => {
    const lib: WebPushLib = {
      sendNotification: vi.fn(async () => {
        throw pushError(500);
      }),
    };
    const sender = createWebPushSender({ ...vapid, webpush: lib });
    expect(await sender.send(subscription, { title: "t", body: "b" })).toBe("failed");
  });
});
