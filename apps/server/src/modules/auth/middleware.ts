import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { SessionUser } from "@webmail/shared";
import { errorResponse } from "../../core/error-response";
import type { SessionStore } from "./sessions";

export const SESSION_COOKIE = "session";

export type AuthVariables = { traceId: string; user: SessionUser };

export function requireSession(
  store: SessionStore,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await store.findUser(token) : null;
    if (!user) {
      return errorResponse(c, "unauthorized", 401);
    }
    c.set("user", user);
    await next();
  };
}
