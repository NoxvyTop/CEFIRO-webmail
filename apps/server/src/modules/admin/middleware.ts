import type { MiddlewareHandler } from "hono";
import { errorResponse } from "../../core/error-response";
import { requireSession, type AuthVariables } from "../auth/middleware";
import type { SessionStore } from "../auth/sessions";

export function requireAdmin(
  sessions: SessionStore,
): [MiddlewareHandler<{ Variables: AuthVariables }>, MiddlewareHandler<{ Variables: AuthVariables }>] {
  return [
    requireSession(sessions),
    async (c, next) => {
      if (c.get("user").role !== "admin") {
        return errorResponse(c, "forbidden", 403);
      }
      await next();
    },
  ];
}
