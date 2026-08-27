import { describe, expect, it } from "vitest";
import {
  pushStatusSchema,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
  pushVapidKeySchema,
} from "./push";

const validSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  expirationTime: null,
  keys: { p256dh: "BExample_p256dh_key", auth: "auth-secret" },
};

describe("push contracts", () => {
  it("accepts a browser PushSubscription toJSON() shape", () => {
    const parsed = pushSubscriptionSchema.parse(validSubscription);
    expect(parsed.endpoint).toBe(validSubscription.endpoint);
    expect(parsed.keys.p256dh).toBe("BExample_p256dh_key");
    expect(parsed.keys.auth).toBe("auth-secret");
  });

  it("accepts a subscription without expirationTime (optional)", () => {
    const { expirationTime: _drop, ...withoutExpiry } = validSubscription;
    expect(() => pushSubscriptionSchema.parse(withoutExpiry)).not.toThrow();
  });

  it("rejects a subscription whose endpoint is not a URL", () => {
    expect(() =>
      pushSubscriptionSchema.parse({ ...validSubscription, endpoint: "not-a-url" }),
    ).toThrow();
  });

  it("rejects a subscription missing the keys object", () => {
    expect(() =>
      pushSubscriptionSchema.parse({ endpoint: validSubscription.endpoint }),
    ).toThrow();
  });

  it("rejects a subscription with an empty p256dh or auth", () => {
    expect(() =>
      pushSubscriptionSchema.parse({ ...validSubscription, keys: { p256dh: "", auth: "x" } }),
    ).toThrow();
    expect(() =>
      pushSubscriptionSchema.parse({ ...validSubscription, keys: { p256dh: "x", auth: "" } }),
    ).toThrow();
  });

  it("accepts and rejects an unsubscribe body by endpoint URL", () => {
    expect(pushUnsubscribeSchema.parse({ endpoint: validSubscription.endpoint }).endpoint).toBe(
      validSubscription.endpoint,
    );
    expect(() => pushUnsubscribeSchema.parse({ endpoint: "nope" })).toThrow();
    expect(() => pushUnsubscribeSchema.parse({})).toThrow();
  });

  it("parses the status flag and rejects a non-boolean", () => {
    expect(pushStatusSchema.parse({ enabled: true }).enabled).toBe(true);
    expect(pushStatusSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(() => pushStatusSchema.parse({ enabled: "yes" })).toThrow();
  });

  it("parses the vapid public key and rejects an empty one", () => {
    expect(pushVapidKeySchema.parse({ publicKey: "BKey" }).publicKey).toBe("BKey");
    expect(() => pushVapidKeySchema.parse({ publicKey: "" })).toThrow();
  });
});
