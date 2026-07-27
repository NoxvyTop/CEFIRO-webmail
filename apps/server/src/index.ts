import { serveStatic } from "hono/bun";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { loadConfig, type AppConfig } from "./core/config";
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
import { createContactsRepo } from "./infra/repos/contacts";
import { findUncoveredKeyVersions } from "./infra/db/key-versions";
import {
  createKeyring,
  importMasterKey,
  knownKeyVersions,
  type Keyring,
} from "./modules/credentials/crypto";
import { createAuthRouter } from "./modules/auth/router";
import { createSessionStore } from "./modules/auth/sessions";
import { createJmapClient } from "./infra/stalwart/jmap";
import { createMailRouter } from "./modules/mail/router";
import { createSieveRouter } from "./modules/sieve/router";
import { createAdminRouter } from "./modules/admin/router";
import { createProfileRouter } from "./modules/profile/router";
import { createContactsRouter } from "./modules/contacts/router";
import { createBootstrap } from "./modules/setup/bootstrap";
import { createSetupRouter } from "./modules/setup/router";
import { createAiRouter } from "./modules/ai/router";
import { createAnthropicAiClient } from "./infra/ai/anthropic";
import { createOpenAiCompatibleClient } from "./infra/ai/openai-compatible";
import type { AiClient } from "./core/ai";

let config: AppConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  log("error", "invalid configuration", { error: String(error) });
  process.exit(1);
}

const db = createDb(config.databaseUrl);
await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));

// The keyring encrypts with MASTER_KEY at MASTER_KEY_VERSION and keeps the
// retired keys listed in MASTER_KEY_PREVIOUS so rows written before a rotation
// stay readable until progressive re-encryption has moved them all over.
let masterKey: CryptoKey;
let keyring: Keyring;
try {
  masterKey = await importMasterKey(config.masterKey);
  const previous = new Map<number, CryptoKey>();
  for (const retired of config.previousMasterKeys) {
    previous.set(retired.version, await importMasterKey(retired.key));
  }
  keyring = createKeyring({ version: config.masterKeyVersion, key: masterKey }, previous);
} catch (error) {
  log("error", "invalid master key ring", { error: String(error) });
  process.exit(1);
}

// A keyring that cannot decrypt what is already stored must fail here, at
// boot, instead of failing per user at runtime the first time each one
// reaches for their mail.
const uncoveredKeyVersions = await findUncoveredKeyVersions(db, keyring);
if (uncoveredKeyVersions.length > 0) {
  log("error", "master key ring cannot decrypt stored rows", {
    uncovered: uncoveredKeyVersions,
    configuredKeyVersions: knownKeyVersions(keyring),
    hint: "list the missing keys in MASTER_KEY_PREVIOUS as version:base64key",
  });
  process.exit(1);
}

const users = createUsersRepo(db);
const audit = createAuditRepo(db);
const sessions = createSessionStore(db);
const ssoConfig = createSsoConfigRepo(db, keyring);
const instanceSettings = createInstanceSettingsRepo(db);
const mailCredentials = createMailCredentialsRepo(db, keyring);
const signatures = createSignaturesRepo(db);
const userPreferences = createUserPreferencesRepo(db);
const filterRules = createFilterRulesRepo(db);
const vacationSettings = createVacationSettingsRepo(db);
const contacts = createContactsRepo(db);
const bootstrap = createBootstrap(config.bootstrapMode);
const jmap = config.stalwartUrl
  ? createJmapClient({ baseUrl: config.stalwartUrl, forceBase: config.jmapForceBase })
  : null;

log("info", "mail proxy", { configured: jmap !== null });

// Software-level default-safe gate: AI features are inert unless explicitly
// enabled AND an API key is configured. See docs/ARCHITECTURE.md ("IA —
// funciones opt-in") — any further network-level restriction is a
// deployment-specific choice outside this software's contract.
//
// Provider selection: "openai-compat" covers any provider speaking the
// OpenAI-compatible `/v1/chat/completions` API (MiniMax, Kimi/Moonshot, or a
// self-hosted Ollama/vLLM/LiteLLM server) via a single adapter configured
// with `aiBaseUrl`. Anything else (default) uses the Anthropic adapter.
// Both tasks currently reuse the same `config.aiModel` — per-task model
// selection is a future enhancement (see GitHub issue #115 "consider").
function buildAiClient(): AiClient | null {
  if (!config.aiEnabled || !config.aiApiKey) return null;
  if (config.aiProvider === "openai-compat") {
    if (!config.aiBaseUrl) {
      log("warn", "ai provider openai-compat requires aiBaseUrl (AI_BASE_URL); AI features disabled", {});
      return null;
    }
    return createOpenAiCompatibleClient({
      apiKey: config.aiApiKey,
      model: config.aiModel,
      baseUrl: config.aiBaseUrl,
    });
  }
  return createAnthropicAiClient({ apiKey: config.aiApiKey, model: config.aiModel });
}

const aiClient: AiClient | null = buildAiClient();

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
  mailRouter: createMailRouter({ sessions, mailCredentials, signatures, userPreferences, jmap, contacts }),
  sieveRouter: createSieveRouter({ sessions, mailCredentials, filterRules, vacationSettings, jmap }),
  adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig, instanceSettings }),
  aiRouter: createAiRouter({ sessions, mailCredentials, jmap, aiClient }),
  profileRouter: createProfileRouter({ sessions, users, audit }),
  contactsRouter: createContactsRouter({ sessions, contacts }),
});

if (process.env.NODE_ENV === "production") {
  const root = process.env.STATIC_DIR ?? "../web/dist";
  app.use("*", serveStatic({ root }));
  app.use("*", serveStatic({ root, path: "index.html" }));
}

log("info", "server started", { port: config.port, bootstrapMode: config.bootstrapMode });

export default { port: config.port, fetch: app.fetch };
