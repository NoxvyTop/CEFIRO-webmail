import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPushStatus,
  fetchVapidPublicKey,
  subscribePush,
  unsubscribePush,
} from "./pushApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

const validSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  expirationTime: null,
  keys: { p256dh: "device-key", auth: "device-auth" },
};

describe("push status client", () => {
  it("returns true when the server reports push enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true }))));
    await expect(fetchPushStatus()).resolves.toBe(true);
  });

  it("returns false when the server reports push disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: false }))));
    await expect(fetchPushStatus()).resolves.toBe(false);
  });

  it("falls back to false on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(fetchPushStatus()).resolves.toBe(false);
  });

  it("falls back to false when fetch throws (offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(fetchPushStatus()).resolves.toBe(false);
  });
});

describe("vapid public key client", () => {
  it("returns the public key when configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ publicKey: "BKey" }))),
    );
    await expect(fetchVapidPublicKey()).resolves.toBe("BKey");
  });

  it("returns null when the key is unavailable (404)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(fetchVapidPublicKey()).resolves.toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(fetchVapidPublicKey()).resolves.toBeNull();
  });
});

describe("subscribe/unsubscribe client", () => {
  it("POSTs the validated subscription as JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(subscribePush(validSubscription)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/push/subscribe");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(validSubscription);
  });

  it("throws MailApiError carrying the envelope code on a failed subscribe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "push_disabled" }), { status: 501 })),
    );
    await expect(subscribePush(validSubscription)).rejects.toMatchObject({
      status: 501,
      code: "push_disabled",
    });
  });

  it("DELETEs the endpoint as JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(unsubscribePush(validSubscription.endpoint)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/push/subscribe");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: validSubscription.endpoint });
  });

  it("throws MailApiError on a failed unsubscribe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "internal" }), { status: 500 })),
    );
    await expect(unsubscribePush(validSubscription.endpoint)).rejects.toMatchObject({
      status: 500,
      code: "internal",
    });
  });
});
