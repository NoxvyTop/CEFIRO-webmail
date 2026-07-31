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

  it("keys on the leftmost X-Forwarded-For hop, so a different client is not blocked", async () => {
    const { app } = await makeApp(2);
    // Same trusted-proxy hop appended on the right; the leftmost (real client)
    // differs, so each client keeps its own budget.
    await get(app, "10.1.0.3, 172.16.0.1");
    await get(app, "10.1.0.3, 172.16.0.1");
    expect((await get(app, "10.1.0.3, 172.16.0.1")).status).toBe(429);
    expect((await get(app, "10.1.0.9, 172.16.0.1")).status).toBe(302);
  });
});
