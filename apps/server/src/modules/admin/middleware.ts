import type { MiddlewareHandler } from "hono";
import { requireSession, type AuthVariables } from "../auth/middleware";
import type { SessionStore } from "../auth/sessions";

export function requireAdmin(
  sessions: SessionStore,
): [MiddlewareHandler<{ Variables: AuthVariables }>, MiddlewareHandler<{ Variables: AuthVariables }>] {
  return [
    requireSession(sessions),
    async (c, next) => {
      if (c.get("user").role !== "admin") {
        return c.json(
          { code: "forbidden", message: "errors.forbidden", traceId: c.get("traceId") },
          403,
        );
      }
      await next();
    },
  ];
}
