import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { SESSION_COOKIE, requireSession, type AuthVariables } from "./middleware";
import type { SessionStore } from "./sessions";

export type AuthRouterDeps = { sessions: SessionStore };

export function createAuthRouter(deps: AuthRouterDeps) {
  const router = new Hono<{ Variables: AuthVariables }>();

  router.get("/me", requireSession(deps.sessions), (c) => c.json(c.get("user")));

  router.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deps.sessions.revoke(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return router;
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
