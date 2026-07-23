import { serveStatic } from "hono/bun";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { loadConfig } from "./core/config";
import { log } from "./core/logger";
import { createDb } from "./infra/db/client";
import { checkDb } from "./infra/db/health";
import { migrate } from "./infra/db/migrate";
import { createAuditRepo } from "./infra/repos/audit";
import { createInstanceSettingsRepo } from "./infra/repos/instance-settings";
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
import { createAiRouter } from "./modules/ai/router";
import { createAnthropicAiClient } from "./infra/ai/anthropic";
import type { AiClient } from "./core/ai";

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
const instanceSettings = createInstanceSettingsRepo(db);
const mailCredentials = createMailCredentialsRepo(db, masterKey);
const signatures = createSignaturesRepo(db);
const userPreferences = createUserPreferencesRepo(db);
const filterRules = createFilterRulesRepo(db);
const vacationSettings = createVacationSettingsRepo(db);
const bootstrap = createBootstrap(config.bootstrapMode);
const jmap = config.stalwartUrl
  ? createJmapClient({ baseUrl: config.stalwartUrl, forceBase: config.jmapForceBase })
  : null;

log("info", "mail proxy", { configured: jmap !== null });

// Software-level default-safe gate: AI features are inert unless explicitly
// enabled AND an API key is configured. See docs/ARCHITECTURE.md ("IA —
// funciones opt-in") — any further network-level restriction is a
// deployment-specific choice outside this software's contract.
const aiClient: AiClient | null =
  config.aiEnabled && config.aiApiKey
    ? createAnthropicAiClient({ apiKey: config.aiApiKey, model: config.aiModel })
    : null;

log("info", "ai features", { enabled: aiClient !== null, provider: config.aiProvider });

if (bootstrap.enabled) {
  log("warn", "bootstrap mode active", {
    user: "bootstrap-admin",
    password: bootstrap.password,
  });
}

const app = createApp({
  checks: { postgres: () => checkDb(db) },
  instanceSettings,
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
  adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig, instanceSettings }),
  aiRouter: createAiRouter({ sessions, mailCredentials, jmap, aiClient }),
});

if (process.env.NODE_ENV === "production") {
  const root = process.env.STATIC_DIR ?? "../web/dist";
  app.use("*", serveStatic({ root }));
  app.use("*", serveStatic({ root, path: "index.html" }));
}

log("info", "server started", { port: config.port, bootstrapMode: config.bootstrapMode });

export default { port: config.port, fetch: app.fetch };
