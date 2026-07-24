import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { updateProfileSchema, type ProfileView } from "@webmail/shared";
import type { AuditRepo } from "../../infra/repos/audit";
import type { UsersRepo } from "../../infra/repos/users";
import { requireSession, type AuthVariables } from "../auth/middleware";
import type { SessionStore } from "../auth/sessions";

// Enough for a ~1MB image inflated ~33% by base64, plus JSON envelope
// overhead. Enforced via bodyLimit (below) so oversized bodies are rejected
// by Content-Length before Hono buffers/JSON-parses them — the ~1MB check
// inside updateProfileSchema's avatar refinement runs only after this gate.
const PATCH_BODY_MAX_BYTES = 2 * 1024 * 1024;

export type ProfileDeps = {
  sessions: SessionStore;
  users: UsersRepo;
  audit: AuditRepo;
};

type Env = { Variables: AuthVariables };

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
  const parsed = schema.safeParse(json) as
    | { success: true; data: T }
    | { success: false };
  return parsed;
}

// Mounted at /api/profile (see app.ts). Every route always acts on the
// session user (c.get("user").userId) — there is no id param, so this
// endpoint has no way to target another user's profile.
export function createProfileRouter(deps: ProfileDeps) {
  const router = new Hono<Env>();

  router.use("*", requireSession(deps.sessions));

  router.get("/", async (c) => {
    const userId = c.get("user").userId;
    const profile = await deps.users.getProfile(userId);
    if (!profile) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    const body: ProfileView = profile;
    return c.json(body);
  });

  router.patch(
    "/",
    bodyLimit({
      maxSize: PATCH_BODY_MAX_BYTES,
      onError: (c) =>
        c.json(
          { code: "payload_too_large", message: "errors.payload_too_large", traceId: c.get("traceId") },
          413,
        ),
    }),
    async (c) => {
      const parsed = await parseBody(c, updateProfileSchema);
      if (!parsed.success) {
        return c.json(
          { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
          400,
        );
      }
      const userId = c.get("user").userId;
      const hasDisplayName = parsed.data.displayName !== undefined;
      const hasAvatar = parsed.data.avatar !== undefined;

      // No-op PATCH ({} or a body with neither field): return the current
      // profile as-is and skip the audit entry — nothing actually changed.
      if (!hasDisplayName && !hasAvatar) {
        const profile = await deps.users.getProfile(userId);
        if (!profile) {
          return c.json(
            { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
            404,
          );
        }
        const body: ProfileView = profile;
        return c.json(body);
      }

      if (hasDisplayName) {
        await deps.users.setDisplayName(userId, parsed.data.displayName!);
      }
      if (hasAvatar) {
        await deps.users.setAvatar(userId, parsed.data.avatar!);
      }
      const profile = await deps.users.getProfile(userId);
      if (!profile) {
        return c.json(
          { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
          404,
        );
      }
      await deps.audit.record({
        actor: c.get("user").email,
        action: "profile.update",
        target: c.get("user").email,
      });
      const body: ProfileView = profile;
      return c.json(body);
    },
  );

  return router;
}

export type ProfileRouter = ReturnType<typeof createProfileRouter>;
