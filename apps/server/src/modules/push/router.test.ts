import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createPushSubscriptionsRepo } from "../../infra/repos/push-subscriptions";
import { createSessionStore } from "../auth/sessions";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createPushRouter } from "./router";
import { createRateLimiter, type RateLimiter } from "../../core/rate-limit";
import type { PushSender } from "../../core/push";

const sql = createDb(testDatabaseUrl());

let sessions: ReturnType<typeof createSessionStore>;
let pushSubscriptions: ReturnType<typeof createPushSubscriptionsRepo>;
let userId: string;
let token: string;

const VAPID_PUBLIC = "BPublicKeyForTheSpaToSubscribeWith";

// A configured push client that does no real network work — the delivery side
// (send) is exercised by the adapter test; these routes only store/remove.
const fakeSender: PushSender = { send: async () => "sent" };

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  pushSubscriptions = createPushSubscriptionsRepo(sql);
  sessions = createSessionStore(sql);
  const user = await users.create({
    email: `push-router-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Push Router User",
  });
  userId = user.id;
  token = (await sessions.create(user.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp(
  pushClient: PushSender | null,
  vapidPublicKey: string | null,
  pushRateLimiter?: RateLimiter,
) {
  return createApp({
    pushRouter: createPushRouter({
      sessions,
      pushSubscriptions,
      pushClient,
      vapidPublicKey,
      pushRateLimiter,
    }),
  });
}

function subscription(endpoint: string) {
  return { endpoint, expirationTime: null, keys: { p256dh: "device-key", auth: "device-auth" } };
}

function authed(method: string, body?: unknown) {
  return {
    method,
    headers: {
      cookie: `session=${token}`,
      "content-type": "application/json",
      "user-agent": "TestAgent/1.0",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("push router — status", () => {
  it("reports enabled=true when a push client is configured", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const res = await app.request("/api/push/status", { headers: { cookie: `session=${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("reports enabled=false when push is not configured", async () => {
    const app = makeApp(null, null);
    const res = await app.request("/api/push/status", { headers: { cookie: `session=${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("requires a session", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const res = await app.request("/api/push/status");
    expect(res.status).toBe(401);
  });
});

describe("push router — vapid public key", () => {
  it("returns the public key when push is configured", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const res = await app.request("/api/push/vapid-public-key", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: VAPID_PUBLIC });
  });

  it("is 404 (unavailable) when push is disabled", async () => {
    const app = makeApp(null, null);
    const res = await app.request("/api/push/vapid-public-key", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("push router — subscribe", () => {
  it("stores the subscription for the session user and captures the user-agent", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const res = await app.request("/api/push/subscribe", authed("POST", subscription(endpoint)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stored = (await pushSubscriptions.listByUser(userId)).find((s) => s.endpoint === endpoint);
    expect(stored).toEqual({ endpoint, p256dh: "device-key", auth: "device-auth" });
    const [row] = await sql<{ user_agent: string | null }[]>`
      select user_agent from push_subscriptions where endpoint = ${endpoint}
    `;
    expect(row?.user_agent).toBe("TestAgent/1.0");
  });

  it("rejects a malformed subscription body with invalid_body", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const res = await app.request(
      "/api/push/subscribe",
      authed("POST", { endpoint: "not-a-url" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns push_disabled when the feature is off, without storing anything", async () => {
    const app = makeApp(null, null);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const res = await app.request("/api/push/subscribe", authed("POST", subscription(endpoint)));
    expect(res.status).toBe(501);
    expect(((await res.json()) as { code: string }).code).toBe("push_disabled");
    expect(await pushSubscriptions.listByUser(userId)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ endpoint })]),
    );
  });

  it("requires a session", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const res = await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription("https://fcm.googleapis.com/fcm/send/x")),
    });
    expect(res.status).toBe(401);
  });
});

describe("push router — unsubscribe", () => {
  it("removes the session user's subscription for the given endpoint", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    await app.request("/api/push/subscribe", authed("POST", subscription(endpoint)));
    expect(
      (await pushSubscriptions.listByUser(userId)).some((s) => s.endpoint === endpoint),
    ).toBe(true);

    const res = await app.request("/api/push/subscribe", authed("DELETE", { endpoint }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(
      (await pushSubscriptions.listByUser(userId)).some((s) => s.endpoint === endpoint),
    ).toBe(false);
  });

  it("rejects a malformed unsubscribe body with invalid_body", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC);
    const res = await app.request("/api/push/subscribe", authed("DELETE", { endpoint: "nope" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });
});

describe("push router — per-user quota", () => {
  it("returns 429 push_rate_limited once the user exceeds the write quota", async () => {
    const app = makeApp(fakeSender, VAPID_PUBLIC, createRateLimiter({ limit: 1, windowMs: 60_000 }));
    const first = await app.request(
      "/api/push/subscribe",
      authed("POST", subscription(`https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`)),
    );
    expect(first.status).toBe(200);

    const blocked = await app.request(
      "/api/push/subscribe",
      authed("POST", subscription(`https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`)),
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as { code: string }).code).toBe("push_rate_limited");
  });
});
