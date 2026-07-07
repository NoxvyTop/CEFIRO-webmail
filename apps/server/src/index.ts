import { serveStatic } from "hono/bun";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { loadConfig } from "./core/config";
import { log } from "./core/logger";
import { createDb } from "./infra/db/client";
import { checkDb } from "./infra/db/health";
import { migrate } from "./infra/db/migrate";
import { createAuditRepo } from "./infra/repos/audit";
import { createMailCredentialsRepo } from "./infra/repos/mail-credentials";
import { createSignaturesRepo } from "./infra/repos/signatures";
import { createSsoConfigRepo } from "./infra/repos/sso-config";
import { createUserPreferencesRepo } from "./infra/repos/user-preferences";
import { createUsersRepo } from "./infra/repos/users";
import { createFilterRulesRepo } from "./infra/repos/filter-rules";
import { createVacationSettingsRepo } from "./infra/repos/vacation-settings";
import { importMasterKey } from "./modules/credentials/crypto";
import { createAuthRouter } from "./modules/auth/router";
import { createSessionStore } from "./modules/auth/sessions";
import { createJmapClient } from "./infra/stalwart/jmap";
import { createMailRouter } from "./modules/mail/router";
import { createSieveRouter } from "./modules/sieve/router";
import { createAdminRouter } from "./modules/admin/router";
import { createBootstrap } from "./modules/setup/bootstrap";
import { createSetupRouter } from "./modules/setup/router";

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  log("error", "invalid configuration", { error: String(error) });
  process.exit(1);
}

const db = createDb(config.databaseUrl);
await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));

const masterKey = await importMasterKey(config.masterKey);
const users = createUsersRepo(db);
const audit = createAuditRepo(db);
const sessions = createSessionStore(db);
const ssoConfig = createSsoConfigRepo(db, masterKey);
const mailCredentials = createMailCredentialsRepo(db, masterKey);
const signatures = createSignaturesRepo(db);
const userPreferences = createUserPreferencesRepo(db);
const filterRules = createFilterRulesRepo(db);
const vacationSettings = createVacationSettingsRepo(db);
const bootstrap = createBootstrap(config.bootstrapMode);
const jmap = config.stalwartUrl ? createJmapClient({ baseUrl: config.stalwartUrl }) : null;

log("info", "mail proxy", { configured: jmap !== null });

if (bootstrap.enabled) {
  log("warn", "bootstrap mode active", {
    user: "bootstrap-admin",
    password: bootstrap.password,
  });
}

const app = createApp({
  checks: { postgres: () => checkDb(db) },
  authRouter: createAuthRouter({
    sessions,
    users,
    audit,
    ssoConfig,
    masterKey,
    appUrl: config.appUrl,
    sessionTtlHours: config.sessionTtlHours,
    bootstrap,
  }),
  setupRouter: createSetupRouter({ bootstrap, users, mailCredentials, ssoConfig, audit }),
  mailRouter: createMailRouter({ sessions, mailCredentials, signatures, userPreferences, jmap }),
  sieveRouter: createSieveRouter({ sessions, mailCredentials, filterRules, vacationSettings, jmap }),
  adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig }),
});

if (process.env.NODE_ENV === "production") {
  const root = process.env.STATIC_DIR ?? "../web/dist";
  app.use("*", serveStatic({ root }));
  app.use("*", serveStatic({ root, path: "index.html" }));
}

log("info", "server started", { port: config.port, bootstrapMode: config.bootstrapMode });

export default { port: config.port, fetch: app.fetch };
