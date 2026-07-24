import { Hono } from "hono";
import {
  createUserInputSchema,
  setActiveInputSchema,
  setMailCredentialInputSchema,
  setRoleInputSchema,
  setupSsoSchema,
  updateInstanceSettingsSchema,
  type AdminSsoView,
  type AdminUser,
  type InstanceSettingsView,
} from "@webmail/shared";
import type { AuditRepo } from "../../infra/repos/audit";
import type { InstanceSettingsRepo } from "../../infra/repos/instance-settings";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UserRecord, UsersRepo } from "../../infra/repos/users";
import type { AuthVariables } from "../auth/middleware";
import type { SessionStore } from "../auth/sessions";
import { evictMailSession } from "../mail/context";
import { requireAdmin } from "./middleware";

export type AdminDeps = {
  sessions: SessionStore;
  users: UsersRepo;
  mailCredentials: MailCredentialsRepo;
  audit: AuditRepo;
  ssoConfig: SsoConfigRepo;
  instanceSettings: InstanceSettingsRepo;
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
    const target = await deps.users.findById(id);
    if (!target) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    const isDemotion = target.role === "admin" && parsed.data.role !== "admin";
    if (isDemotion) {
      if (c.get("user").userId === id) {
        return c.json(
          { code: "self_demotion", message: "errors.self_demotion", traceId: c.get("traceId") },
          409,
        );
      }
      if (target.active && (await deps.users.countActiveAdmins()) <= 1) {
        return c.json(
          { code: "last_admin", message: "errors.last_admin", traceId: c.get("traceId") },
          409,
        );
      }
    }
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
    const target = await deps.users.findById(id);
    if (!target) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    await deps.mailCredentials.set(id, parsed.data.mailPassword);
    // Drop any cached JMAP session bound to the previous credentials.
    evictMailSession(id);
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
    if (!parsed.data.active) {
      const target = await deps.users.findById(id);
      if (!target) {
        return c.json(
          { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
          404,
        );
      }
      if (c.get("user").userId === id) {
        return c.json(
          { code: "self_archive", message: "errors.self_archive", traceId: c.get("traceId") },
          409,
        );
      }
      if (target.role === "admin" && target.active && (await deps.users.countActiveAdmins()) <= 1) {
        return c.json(
          { code: "last_admin", message: "errors.last_admin", traceId: c.get("traceId") },
          409,
        );
      }
    }
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
      // Drop the cached JMAP session so archived access cannot linger.
      evictMailSession(id);
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

  router.get("/instance", async (c) => {
    const settings = await deps.instanceSettings.get();
    const body: InstanceSettingsView = { sentWithFooter: settings.sentWithFooterEnabled };
    return c.json(body);
  });

  router.put("/instance", async (c) => {
    const parsed = await parseBody(c, updateInstanceSettingsSchema);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    await deps.instanceSettings.set({ sentWithFooterEnabled: parsed.data.sentWithFooter });
    await deps.audit.record({
      actor: c.get("user").email,
      action: "instance_settings.update",
      detail: { sentWithFooter: parsed.data.sentWithFooter },
    });
    const body: InstanceSettingsView = { sentWithFooter: parsed.data.sentWithFooter };
    return c.json(body);
  });

  return router;
}

export type AdminRouter = ReturnType<typeof createAdminRouter>;
