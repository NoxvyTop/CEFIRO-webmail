import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import { createAuthRouter, type OidcClient } from "./router";
import { createRateLimiter } from "../../core/rate-limit";
import { importMasterKey } from "../credentials/crypto";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { SessionStore } from "./sessions";

// Route-level fakes (no DB): GH #194 rate-limits the unauthenticated OIDC login
// start so its outbound oidc.discover() cannot be amplified. A spy on discover
// proves a blocked request never reaches the IdP.

function fakeSsoConfig(): SsoConfigRepo {
  return {
    get: async () => ({
      issuer: "https://auth.test",
      clientId: "webmail",
      clientSecret: "s",
      scopes: "openid email",
    }),
  } as unknown as SsoConfigRepo;
}

function fakeSessions(): SessionStore {
  return {
    create: async () => ({ token: "t", expiresAt: new Date() }),
  } as unknown as SessionStore;
}

async function makeApp(limit: number) {
  const masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  const discover = vi.fn(async () => ({
    authorizationEndpoint: "https://auth.test/authorize",
    tokenEndpoint: "https://auth.test/token",
    jwksUri: "https://auth.test/jwks",
  }));
  const oidcClient: OidcClient = {
    discover,
    exchangeCode: async () => ({ idToken: "stub" }),
    createVerifier: () => async () => ({ email: "user@noxvytop.com" }),
  };
  const app = createApp({
    authRouter: createAuthRouter({
      sessions: fakeSessions(),
      ssoConfig: fakeSsoConfig(),
      masterKey,
      appUrl: "http://localhost:5173",
      oidcClient,
      loginRateLimiter: createRateLimiter({ limit, windowMs: 60_000 }),
    }),
  });
  return { app, discover };
}

function get(app: Awaited<ReturnType<typeof makeApp>>["app"], ip?: string) {
  return app.request("/api/auth/login", {
    headers: ip ? { "x-forwarded-for": ip } : {},
  });
}

describe("login rate limiting (GH #194)", () => {
  it("returns 429 with Retry-After once an IP exceeds the limit", async () => {
    const { app } = await makeApp(2);
    expect((await get(app, "10.1.0.1")).status).toBe(302);
    expect((await get(app, "10.1.0.1")).status).toBe(302);
    const blocked = await get(app, "10.1.0.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as { code: string }).code).toBe("too_many_requests");
  });

  it("does not run the outbound oidc.discover() for a blocked request", async () => {
    const { app, discover } = await makeApp(2);
    await get(app, "10.1.0.2");
    await get(app, "10.1.0.2");
    expect(discover).toHaveBeenCalledTimes(2);
    const blocked = await get(app, "10.1.0.2");
    expect(blocked.status).toBe(429);
    // The blocked request must not have amplified into a third discovery call.
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("keys on the trusted hop counted from the RIGHT, so a real client keeps its own budget", async () => {
    const { app } = await makeApp(2);
    // One trusted proxy appends the client's address, so it is the LAST entry.
    await get(app, "10.1.0.3");
    await get(app, "10.1.0.3");
    expect((await get(app, "10.1.0.3")).status).toBe(429);
    expect((await get(app, "10.1.0.9")).status).toBe(302);
  });

  // GH #238. This used to take the LEFTMOST entry, which under the appending
  // proxy this deployment documents is exactly the part the caller wrote — so
  // one forged prefix per request bought a fresh budget every time and the
  // ceiling GH #194 added never bound anything.
  it("gives no new budget for forged hops prepended to X-Forwarded-For", async () => {
    const { app, discover } = await makeApp(2);
    expect((await get(app, "10.1.0.4")).status).toBe(302);
    expect((await get(app, "203.0.113.1, 10.1.0.4")).status).toBe(302);
    // Third attempt from the same real client, third different forgery.
    expect((await get(app, "198.51.100.2, 203.0.113.9, 10.1.0.4")).status).toBe(429);
    // And the blocked one never reached the IdP.
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("puts a request that skipped the proxy in the shared bucket, not one of its own", async () => {
    const { app } = await makeApp(1);
    // No header at all: nothing attributable, so it shares ONE bucket with
    // every other unattributable request rather than getting a private budget.
    expect((await get(app)).status).toBe(302);
    expect((await get(app)).status).toBe(429);
  });

  it("refuses an over-long forged address instead of keying on it", async () => {
    // The one topology where the selected entry can still be caller-written is
    // a process exposed directly while claiming a trusted hop. Nothing there
    // may become an unbounded rate-limiter key or audit value.
    const { app } = await makeApp(1);
    expect((await get(app, "x".repeat(46))).status).toBe(302);
    // Shares the unattributed bucket the previous request just spent.
    expect((await get(app, "y".repeat(200))).status).toBe(429);
  });
});
