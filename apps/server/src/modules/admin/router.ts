import { Hono } from "hono";
import {
  createUserInputSchema,
  setActiveInputSchema,
  setMailCredentialInputSchema,
  setRoleInputSchema,
  setupSsoSchema,
  type AdminSsoView,
  type AdminUser,
} from "@webmail/shared";
import type { AuditRepo } from "../../infra/repos/audit";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UserRecord, UsersRepo } from "../../infra/repos/users";
import type { AuthVariables } from "../auth/middleware";
import type { SessionStore } from "../auth/sessions";
import { requireAdmin } from "./middleware";

export type AdminDeps = {
  sessions: SessionStore;
  users: UsersRepo;
  mailCredentials: MailCredentialsRepo;
  audit: AuditRepo;
  ssoConfig: SsoConfigRepo;
};

type Env = { Variables: AuthVariables };

async function toAdminUser(deps: AdminDeps, user: UserRecord): Promise<AdminUser> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    locale: user.locale,
    active: user.active,
    mailboxLinked: await deps.mailCredentials.exists(user.id),
  };
}

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

export function createAdminRouter(deps: AdminDeps) {
  const router = new Hono<Env>();

  router.use("*", ...requireAdmin(deps.sessions));

  router.get("/users", async (c) => {
    const users = await deps.users.list();
    const body: AdminUser[] = await Promise.all(users.map((u) => toAdminUser(deps, u)));
    return c.json(body);
  });

  router.post("/users", async (c) => {
    const parsed = await parseBody(c, createUserInputSchema);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const { email, displayName, role, locale, mailPassword } = parsed.data;
    if (await deps.users.findByEmail(email)) {
      return c.json(
        { code: "user_exists", message: "errors.user_exists", traceId: c.get("traceId") },
        409,
      );
    }
    const user = await deps.users.create({ email, displayName, role, locale });
    if (mailPassword) {
      await deps.mailCredentials.set(user.id, mailPassword);
    }
    await deps.audit.record({
      actor: c.get("user").email,
      action: "user.create",
      target: user.email,
      detail: { role: user.role },
    });
    return c.json(await toAdminUser(deps, user));
  });

  router.put("/users/:id/role", async (c) => {
    const parsed = await parseBody(c, setRoleInputSchema);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const id = c.req.param("id");
    const updated = await deps.users.setRole(id, parsed.data.role);
    if (!updated) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    await deps.audit.record({
      actor: c.get("user").email,
      action: "user.role_change",
      target: updated.email,
      detail: { role: updated.role },
    });
    return c.json(await toAdminUser(deps, updated));
  });

  router.put("/users/:id/credential", async (c) => {
    const parsed = await parseBody(c, setMailCredentialInputSchema);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const id = c.req.param("id");
    const target = (await deps.users.list()).find((u) => u.id === id);
    if (!target) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    await deps.mailCredentials.set(id, parsed.data.mailPassword);
    await deps.audit.record({
      actor: c.get("user").email,
      action: "user.credential_set",
      target: target.email,
    });
    return c.json({ ok: true });
  });

  router.put("/users/:id/active", async (c) => {
    const parsed = await parseBody(c, setActiveInputSchema);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const id = c.req.param("id");
    const updated = await deps.users.setActive(id, parsed.data.active);
    if (!updated) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    if (parsed.data.active) {
      await deps.audit.record({
        actor: c.get("user").email,
        action: "user.reactivate",
        target: updated.email,
      });
    } else {
      const revokedSessions = await deps.sessions.revokeAllForUser(id);
      await deps.audit.record({
        actor: c.get("user").email,
        action: "user.archive",
        target: updated.email,
        detail: { revokedSessions },
      });
    }
    return c.json(await toAdminUser(deps, updated));
  });

  router.get("/sso", async (c) => {
    const pub = await deps.ssoConfig.getPublic();
    const body: AdminSsoView = pub
      ? { configured: true, ...pub }
      : { configured: false, issuer: null, clientId: null, scopes: null };
    return c.json(body);
  });

  router.put("/sso", async (c) => {
    const parsed = await parseBody(c, setupSsoSchema);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    await deps.ssoConfig.set(parsed.data);
    await deps.audit.record({
      actor: c.get("user").email,
      action: "sso_config.update",
      target: parsed.data.issuer,
      detail: { issuer: parsed.data.issuer, clientId: parsed.data.clientId },
    });
    return c.json({ ok: true });
  });

  return router;
}

export type AdminRouter = ReturnType<typeof createAdminRouter>;
