import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disablePush,
  enablePush,
  getExistingPushSubscription,
  isPushSupported,
  resyncPushSubscription,
  urlBase64ToUint8Array,
} from "./push";
import { fetchVapidPublicKey, subscribePush, unsubscribePush } from "./pushApi";

vi.mock("./pushApi", () => ({
  fetchVapidPublicKey: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}));

const fetchVapidPublicKeyMock = vi.mocked(fetchVapidPublicKey);
const subscribePushMock = vi.mocked(subscribePush);
const unsubscribePushMock = vi.mocked(unsubscribePush);

const SUBSCRIPTION_JSON = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  expirationTime: null,
  keys: { p256dh: "device-key", auth: "device-auth" },
};

/** Installs a browser environment that supports push, with injectable hooks. */
function stubSupportedBrowser(overrides: {
  permission?: NotificationPermission;
  subscribe?: () => Promise<unknown>;
  getSubscription?: () => Promise<unknown>;
  getRegistration?: () => Promise<unknown>;
} = {}) {
  const registration = {
    pushManager: {
      subscribe:
        overrides.subscribe ??
        (async () => ({ toJSON: () => SUBSCRIPTION_JSON, endpoint: SUBSCRIPTION_JSON.endpoint })),
      getSubscription: overrides.getSubscription ?? (async () => null),
    },
  };
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: overrides.getRegistration ?? (async () => registration),
    },
  });
  vi.stubGlobal("PushManager", class PushManager {});
  vi.stubGlobal("Notification", {
    requestPermission: vi.fn(async () => overrides.permission ?? "granted"),
  });
  return registration;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url string into the expected bytes", () => {
    // "AQID" (standard base64) === bytes [1, 2, 3]; the url-safe path just swaps
    // the alphabet and restores padding.
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
  });

  it("restores padding and the url-safe alphabet", () => {
    // "-_8" is url-safe for "+/8"; padded to "+/8=" it decodes to [251, 255].
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});

describe("isPushSupported", () => {
  it("is true when serviceWorker, PushManager and Notification are all present", () => {
    stubSupportedBrowser();
    expect(isPushSupported()).toBe(true);
  });

  it("is false when the browser lacks PushManager", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("Notification", { requestPermission: vi.fn() });
    // No PushManager stubbed.
    expect(isPushSupported()).toBe(false);
  });
});

describe("enablePush", () => {
  it("returns 'unsupported' and does no work when push is unsupported", async () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("Notification", { requestPermission: vi.fn() });
    expect(await enablePush()).toBe("unsupported");
    expect(fetchVapidPublicKeyMock).not.toHaveBeenCalled();
  });

  it("returns 'unavailable' when the server has no VAPID key", async () => {
    stubSupportedBrowser();
    fetchVapidPublicKeyMock.mockResolvedValue(null);
    expect(await enablePush()).toBe("unavailable");
    expect(subscribePushMock).not.toHaveBeenCalled();
  });

  it("returns 'denied' when the user refuses permission, without subscribing", async () => {
    stubSupportedBrowser({ permission: "denied" });
    fetchVapidPublicKeyMock.mockResolvedValue("AQID");
    expect(await enablePush()).toBe("denied");
    expect(subscribePushMock).not.toHaveBeenCalled();
  });

  it("subscribes and POSTs the subscription on the happy path", async () => {
    stubSupportedBrowser({ permission: "granted" });
    fetchVapidPublicKeyMock.mockResolvedValue("AQID");
    subscribePushMock.mockResolvedValue(undefined);

    expect(await enablePush()).toBe("subscribed");
    expect(subscribePushMock).toHaveBeenCalledWith(SUBSCRIPTION_JSON);
  });
});

describe("getExistingPushSubscription / disablePush", () => {
  it("returns the current subscription when one exists", async () => {
    const sub = { endpoint: SUBSCRIPTION_JSON.endpoint };
    stubSupportedBrowser({ getSubscription: async () => sub });
    expect(await getExistingPushSubscription()).toBe(sub);
  });

  it("unsubscribes the browser and tells the server to forget the endpoint", async () => {
    const unsubscribe = vi.fn(async () => true);
    const sub = { endpoint: SUBSCRIPTION_JSON.endpoint, unsubscribe };
    stubSupportedBrowser({ getSubscription: async () => sub });
    unsubscribePushMock.mockResolvedValue(undefined);

    await disablePush();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribePushMock).toHaveBeenCalledWith(SUBSCRIPTION_JSON.endpoint);
  });

  it("is a no-op when there is nothing subscribed", async () => {
    stubSupportedBrowser({ getSubscription: async () => null });
    await disablePush();
    expect(unsubscribePushMock).not.toHaveBeenCalled();
  });
});

// GH #337: the panel used to trust the browser alone ("this device has a
// PushSubscription, therefore the server knows about it"). A server that lost
// the row — restored backup, pruned as expired, a user re-linked on another
// machine — then never pushed again, and nothing in the UI said so.
describe("resyncPushSubscription", () => {
  it("re-posts this device's existing subscription to the server", async () => {
    const sub = { endpoint: SUBSCRIPTION_JSON.endpoint, toJSON: () => SUBSCRIPTION_JSON };
    stubSupportedBrowser({ getSubscription: async () => sub });
    subscribePushMock.mockResolvedValue(undefined);

    expect(await resyncPushSubscription()).toBe(true);
    expect(subscribePushMock).toHaveBeenCalledWith(SUBSCRIPTION_JSON);
  });

  it("reports no subscription without calling the server", async () => {
    stubSupportedBrowser({ getSubscription: async () => null });

    expect(await resyncPushSubscription()).toBe(false);
    expect(subscribePushMock).not.toHaveBeenCalled();
  });

  it("still reports the device as subscribed when the re-post fails", async () => {
    const sub = { endpoint: SUBSCRIPTION_JSON.endpoint, toJSON: () => SUBSCRIPTION_JSON };
    stubSupportedBrowser({ getSubscription: async () => sub });
    subscribePushMock.mockRejectedValue(new Error("offline"));

    expect(await resyncPushSubscription()).toBe(true);
  });
});
