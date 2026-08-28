import { describe, expect, it, vi } from "vitest";
import { createBrowserApp as createApp } from "../../test/browser-app";
import { createAuthRouter } from "./router";
import { createBootstrap, type Bootstrap } from "../setup/bootstrap";
import { createRateLimiter } from "../../core/rate-limit";
import type { AuditEntry, AuditRepo } from "../../infra/repos/audit";
import type { UserRecord, UsersRepo } from "../../infra/repos/users";
import type { SessionStore } from "./sessions";

// Route-level fakes: unlike the DB-backed bootstrap-login.test.ts, this suite
// injects in-memory doubles so it can assert directly on the audit repo's
// calls — the whole point of GH #183 is that a rate-limited request must write
// ZERO audit rows.

// Operator-set break-glass credential (GH #235): the process no longer mints
// one, so a bootstrap that is meant to be enabled has to be handed a secret.
const BOOTSTRAP_PASSWORD = "test-bootstrap-secret-0123456789";

function fakeAudit() {
  return { record: vi.fn(async (_entry: AuditEntry) => {}) };
}

function fakeUsers(): UsersRepo {
  const admin: UserRecord = {
    id: "admin-1",
    email: "bootstrap-admin@webmail.local",
    displayName: "Bootstrap Admin",
    role: "admin",
    locale: "es",
    active: true,
  };
  let created = false;
  return {
    findByEmail: vi.fn(async () => (created ? admin : null)),
    create: vi.fn(async () => {
      created = true;
      return admin;
    }),
    setActive: vi.fn(async () => admin),
    setRole: vi.fn(async () => admin),
  } as unknown as UsersRepo;
}

function fakeSessions(): SessionStore {
  return {
    create: vi.fn(async () => ({ token: "session-token", expiresAt: new Date() })),
  } as unknown as SessionStore;
}

function makeApp(overrides: {
  boot: Bootstrap;
  audit: ReturnType<typeof fakeAudit>;
  limit?: number;
}) {
  return createApp({
    authRouter: createAuthRouter({
      sessions: fakeSessions(),
      users: fakeUsers(),
      audit: overrides.audit as unknown as AuditRepo,
      bootstrap: overrides.boot,
      appUrl: "http://localhost:5173",
      sessionTtlHours: 1,
      rateLimiter: createRateLimiter({ limit: overrides.limit ?? 3, windowMs: 60_000 }),
    }),
  });
}

function post(app: ReturnType<typeof makeApp>, password: string, ip?: string) {
  return app.request("/api/auth/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: JSON.stringify({ email: "bootstrap-admin", password }),
  });
}

describe("bootstrap login rate limiting", () => {
  it("returns 429 with Retry-After once an IP exceeds the limit", async () => {
    const audit = fakeAudit();
    const app = makeApp({ boot: createBootstrap(true, BOOTSTRAP_PASSWORD), audit, limit: 3 });

    for (let i = 0; i < 3; i++) {
      const res = await post(app, "wrong", "10.0.0.1");
      expect(res.status).toBe(401);
    }
    const blocked = await post(app, "wrong", "10.0.0.1");
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(((await blocked.json()) as { code: string }).code).toBe("too_many_requests");
  });

  it("writes NO audit row for a 429'd request", async () => {
    const audit = fakeAudit();
    const app = makeApp({ boot: createBootstrap(true, BOOTSTRAP_PASSWORD), audit, limit: 3 });

    for (let i = 0; i < 3; i++) await post(app, "wrong", "10.0.0.2");
    // The three allowed failures each recorded exactly one login_failed row.
    expect(audit.record).toHaveBeenCalledTimes(3);

    const blocked = await post(app, "wrong", "10.0.0.2");
    expect(blocked.status).toBe(429);
    // The blocked request must not have amplified into a fourth audit row.
    expect(audit.record).toHaveBeenCalledTimes(3);
    for (const [entry] of audit.record.mock.calls) {
      expect(entry.action).toBe("bootstrap.login_failed");
    }
  });

  it("does not block a different IP", async () => {
    const audit = fakeAudit();
    const app = makeApp({ boot: createBootstrap(true, BOOTSTRAP_PASSWORD), audit, limit: 3 });

    for (let i = 0; i < 4; i++) await post(app, "wrong", "10.0.0.3");
    // A fresh IP still has its own budget: it fails auth (401), it is not 429'd.
    const other = await post(app, "wrong", "10.0.0.9");
    expect(other.status).toBe(401);
  });

  it("still lets a correct password through within the limit", async () => {
    const audit = fakeAudit();
    const boot = createBootstrap(true, BOOTSTRAP_PASSWORD);
    const app = makeApp({ boot, audit, limit: 3 });

    const res = await post(app, boot.password ?? "", "10.0.0.4");
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().some((line) => line.startsWith("session="));
    expect(setCookie).toBe(true);
  });
});
