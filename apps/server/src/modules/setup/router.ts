import { Hono } from "hono";
import { setupSsoSchema, setupUserSchema, type SetupStatus } from "@webmail/shared";
import { errorResponse } from "../../core/error-response";
import type { AuditRepo } from "../../infra/repos/audit";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UsersRepo } from "../../infra/repos/users";
import type { Bootstrap } from "./bootstrap";

export const SETUP_TOKEN_HEADER = "x-setup-token";

export type SetupRouterDeps = {
  bootstrap: Bootstrap;
  users: UsersRepo;
  mailCredentials: MailCredentialsRepo;
  ssoConfig: SsoConfigRepo;
  audit: AuditRepo;
};

type Env = { Variables: { traceId: string } };

export function createSetupRouter(deps: SetupRouterDeps) {
  const router = new Hono<Env>();

  router.use("*", async (c, next) => {
    if (!deps.bootstrap.enabled) {
      return errorResponse(c, "not_found", 404);
    }
    const token = c.req.header(SETUP_TOKEN_HEADER);
    if (!token || !(await deps.bootstrap.verify(token))) {
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
    const parsed = setupSsoSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    await deps.ssoConfig.set(parsed.data);
    await deps.audit.record({
      actor: "bootstrap-admin",
      action: "sso_config.update",
      detail: { issuer: parsed.data.issuer, clientId: parsed.data.clientId },
    });
    return c.json({ ok: true });
  });

  router.post("/users", async (c) => {
    const parsed = setupUserSchema.safeParse(await c.req.json());
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
      actor: "bootstrap-admin",
      action: "user.create",
      target: email,
      detail: { role },
    });
    return c.json(user);
  });

  return router;
}

export type SetupRouter = ReturnType<typeof createSetupRouter>;
