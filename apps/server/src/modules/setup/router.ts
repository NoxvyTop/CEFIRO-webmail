import { Hono } from "hono";
import { setupSsoSchema, setupUserSchema, type SetupStatus } from "@webmail/shared";
import { clientIp, DEFAULT_TRUSTED_PROXY_HOPS, rateLimitKey } from "../../core/client-ip";
import { errorResponse } from "../../core/error-response";
import { createRateLimiter, type RateLimiter } from "../../core/rate-limit";
import type { AuditRepo } from "../../infra/repos/audit";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UsersRepo } from "../../infra/repos/users";
import type { Bootstrap } from "./bootstrap";
import { createSetupCompletion, type SetupCompletion } from "./completion";

export const SETUP_TOKEN_HEADER = "x-setup-token";

/** Actor recorded for every setup action; the same name the bootstrap login uses. */
const SETUP_ACTOR = "bootstrap-admin";

// Rate limit for the setup API, keyed by client IP (GH #222).
//
// This router authenticates with the SAME 144-bit break-glass secret as the
// bootstrap login (setup/bootstrap.ts), is reachable UNAUTHENTICATED while
// bootstrap mode is on, and — now that failures are audited — writes a row per
// rejected attempt. That is the audit-log flooding vector GH #183 closed on the
// login path, so it gets the same fixed-window limiter, checked before the
// token is verified or any audit row is written.
//
// The ceiling is higher than the login's 10/min because this middleware guards
// the whole wizard, not one endpoint: connecting costs a request, saving SSO
// costs another, and every user an operator seeds costs one more (see
// apps/web SetupPage). 30/min per IP leaves a real setup session — including a
// batch of user creations and a few retyped tokens — untouched, while a flood
// is refused after the first handful. Lockout lasts at most one window (~60s).
const SETUP_MAX_ATTEMPTS = 30;
const SETUP_WINDOW_MS = 60_000;

export type SetupRouterDeps = {
  bootstrap: Bootstrap;
  users: UsersRepo;
  mailCredentials: MailCredentialsRepo;
  ssoConfig: SsoConfigRepo;
  audit: AuditRepo;
  /** Injectable so tests drive a small limit; see core/rate-limit.ts. */
  rateLimiter?: RateLimiter;
  /**
   * Proxy hops to trust in `X-Forwarded-For` (GH #238). Keys the ceiling below
   * and the audit `ip` column; see core/client-ip.ts.
   */
  trustedProxyHops?: number;
  /**
   * Completion latch (GH #234), derived from `users`/`ssoConfig` by default.
   * Injectable because the integration suite shares one database across every
   * test file, so which side of the latch this router is on has to be stated
   * rather than inherited from whatever another file happened to write.
   */
  completion?: SetupCompletion;
};

type Env = { Variables: { traceId: string } };

/**
 * Reads and validates a JSON body, treating an unparseable one as a validation
 * failure rather than letting it throw (GH #222). Before this, a malformed body
 * escaped as a 500 — and per GH #48 that response leaves without the security
 * headers the normal path carries. Same helper the admin and profile routers
 * use.
 */
async function parseBody<T>(
  c: { req: { json(): Promise<unknown> } },
  schema: { safeParse(input: unknown): { success: boolean; data?: T } },
): Promise<{ success: true; data: T } | { success: false }> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return { success: false };
  }
  const parsed = schema.safeParse(json) as { success: true; data: T } | { success: false };
  return parsed;
}

export function createSetupRouter(deps: SetupRouterDeps) {
  const router = new Hono<Env>();
  // One limiter per router instance, living in this closure so its counters
  // persist across requests — the same shape modules/auth/router.ts uses.
  const rateLimiter =
    deps.rateLimiter ??
    createRateLimiter({ limit: SETUP_MAX_ATTEMPTS, windowMs: SETUP_WINDOW_MS });
  const completion = deps.completion ?? createSetupCompletion(deps);
  const trustedProxyHops = deps.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;

  router.use("*", async (c, next) => {
    if (!deps.bootstrap.enabled) {
      return errorResponse(c, "not_found", 404);
    }
    // Client IP for the rate gate and the audit row, attributed by counting
    // trusted hops from the RIGHT of X-Forwarded-For (GH #238). This used to be
    // the RAW header, so one junk hop per request minted one bucket per request
    // and this ceiling — the one guarding an UNAUTHENTICATED router that holds
    // the same 144-bit secret as the break-glass login — bound nothing at all.
    const ip = clientIp(c, trustedProxyHops);
    // Gate BEFORE verifying the token or writing any audit row, so a blocked
    // flood produces ZERO `setup.auth_failed` rows.
    const gate = rateLimiter.check(rateLimitKey(c, trustedProxyHops));
    if (!gate.allowed) {
      c.header("Retry-After", String(gate.retryAfterSeconds));
      return errorResponse(c, "too_many_requests", 429);
    }
    // Second gate (GH #234): a setup that already happened closes this router
    // for good, whatever `BOOTSTRAP_MODE` still says. Until now the flag was
    // the ONLY gate, so one left on in production kept an unauthenticated
    // path open forever for anyone holding the token — repoint the IdP at
    // their own provider (PUT /sso), seed themselves a `role:"admin"` user
    // (POST /users), sign in. See ./completion.ts for how "already happened"
    // is decided and why it can never lock an operator out.
    //
    // Answering the SAME `not_found` as a router that was never enabled is
    // deliberate: a completed instance must not confirm that it has a setup
    // API at all, and the SPA's /setup screen already renders that 404 as
    // "setup is disabled", which is the truth. Placed AHEAD of the token
    // check so a closed router verifies no secrets and writes no audit rows,
    // exactly like a disabled one; behind the rate gate so the two reads it
    // costs are bounded per IP, and they stop entirely once it latches.
    if (await completion.isComplete()) {
      return errorResponse(c, "not_found", 404);
    }
    const token = c.req.header(SETUP_TOKEN_HEADER);
    if (!token || !(await deps.bootstrap.verify(token))) {
      // A rejected setup token is a failed authentication against the same
      // break-glass secret as the bootstrap login, and was invisible until now.
      await deps.audit.record({ actor: SETUP_ACTOR, action: "setup.auth_failed", ip });
      return errorResponse(c, "unauthorized", 401);
    }
    await next();
  });

  router.get("/status", async (c) => {
    const body: SetupStatus = {
      bootstrapMode: true,
      ssoConfigured: await deps.ssoConfig.exists(),
      userCount: await deps.users.count(),
    };
    return c.json(body);
  });

  router.put("/sso", async (c) => {
    const parsed = await parseBody(c, setupSsoSchema);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    await deps.ssoConfig.set(parsed.data);
    await deps.audit.record({
      actor: SETUP_ACTOR,
      action: "sso_config.update",
      detail: { issuer: parsed.data.issuer, clientId: parsed.data.clientId },
    });
    return c.json({ ok: true });
  });

  router.post("/users", async (c) => {
    const parsed = await parseBody(c, setupUserSchema);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const { email, displayName, role, locale, mailPassword } = parsed.data;
    if (await deps.users.findByEmail(email)) {
      return errorResponse(c, "user_exists", 409);
    }
    const user = await deps.users.create({ email, displayName, role, locale });
    await deps.mailCredentials.set(user.id, mailPassword);
    await deps.audit.record({
      actor: SETUP_ACTOR,
      action: "user.create",
      target: email,
      detail: { role },
    });
    return c.json(user);
  });

  return router;
}

export type SetupRouter = ReturnType<typeof createSetupRouter>;
