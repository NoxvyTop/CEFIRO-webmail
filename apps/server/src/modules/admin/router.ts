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
import { errorResponse } from "../../core/error-response";
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

async function toAdminUser(
  deps: AdminDeps,
  user: UserRecord,
  avatarDataUrl: string | null,
): Promise<AdminUser> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    locale: user.locale,
    active: user.active,
    mailboxLinked: await deps.mailCredentials.exists(user.id),
    avatarDataUrl,
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
    const users = await deps.users.listWithAvatar();
    const body: AdminUser[] = await Promise.all(
      users.map((u) => toAdminUser(deps, u, u.avatarDataUrl)),
    );
    return c.json(body);
  });

  router.post("/users", async (c) => {
    const parsed = await parseBody(c, createUserInputSchema);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const { email, displayName, role, locale, mailPassword } = parsed.data;
    if (await deps.users.findByEmail(email)) {
      return errorResponse(c, "user_exists", 409);
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
    // A just-created user has never uploaded a photo yet.
    return c.json(await toAdminUser(deps, user, null));
  });

  router.put("/users/:id/role", async (c) => {
    const parsed = await parseBody(c, setRoleInputSchema);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const id = c.req.param("id");
    const target = await deps.users.findById(id);
    if (!target) {
      return errorResponse(c, "not_found", 404);
    }
    const isDemotion = target.role === "admin" && parsed.data.role !== "admin";
    if (isDemotion) {
      if (c.get("user").userId === id) {
        return errorResponse(c, "self_demotion", 409);
      }
      if (target.active && (await deps.users.countActiveAdmins()) <= 1) {
        return errorResponse(c, "last_admin", 409);
      }
    }
    const updated = await deps.users.setRole(id, parsed.data.role);
    if (!updated) {
      return errorResponse(c, "not_found", 404);
    }
    await deps.audit.record({
      actor: c.get("user").email,
      action: "user.role_change",
      target: updated.email,
      detail: { role: updated.role },
    });
    const profile = await deps.users.getProfile(updated.id);
    return c.json(await toAdminUser(deps, updated, profile?.avatarDataUrl ?? null));
  });

  router.put("/users/:id/credential", async (c) => {
    const parsed = await parseBody(c, setMailCredentialInputSchema);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const id = c.req.param("id");
    const target = await deps.users.findById(id);
    if (!target) {
      return errorResponse(c, "not_found", 404);
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
      return errorResponse(c, "invalid_body", 400);
    }
    const id = c.req.param("id");
    if (!parsed.data.active) {
      const target = await deps.users.findById(id);
      if (!target) {
        return errorResponse(c, "not_found", 404);
      }
      if (c.get("user").userId === id) {
        return errorResponse(c, "self_archive", 409);
      }
      if (target.role === "admin" && target.active && (await deps.users.countActiveAdmins()) <= 1) {
        return errorResponse(c, "last_admin", 409);
      }
    }
    const updated = await deps.users.setActive(id, parsed.data.active);
    if (!updated) {
      return errorResponse(c, "not_found", 404);
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
    const profile = await deps.users.getProfile(updated.id);
    return c.json(await toAdminUser(deps, updated, profile?.avatarDataUrl ?? null));
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
      return errorResponse(c, "invalid_body", 400);
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
      return errorResponse(c, "invalid_body", 400);
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
