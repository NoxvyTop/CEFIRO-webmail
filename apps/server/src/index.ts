import { serveStatic } from "hono/bun";
import { fileURLToPath } from "node:url";
import { createApp, type HealthCheck } from "./app";
import { loadConfig, type AppConfig } from "./core/config";
import { log } from "./core/logger";
import { registerServer } from "./core/idle-timeout";
import { createShutdown, installProcessHandlers } from "./core/shutdown";
import { createDb } from "./infra/db/client";
import { checkDb } from "./infra/db/health";
import { checkStalwart } from "./infra/stalwart/health";
import { migrate } from "./infra/db/migrate";
import { createAuditRepo } from "./infra/repos/audit";
import { createInstanceSettingsRepo } from "./infra/repos/instance-settings";
import { createMailCredentialsRepo } from "./infra/repos/mail-credentials";
import { createSignaturesRepo } from "./infra/repos/signatures";
import { createSsoConfigRepo } from "./infra/repos/sso-config";
import { createUserPreferencesRepo } from "./infra/repos/user-preferences";
import { createUsersRepo } from "./infra/repos/users";
import { createFilterRulesRepo } from "./infra/repos/filter-rules";
import { createSieveSyncStateRepo } from "./infra/repos/sieve-sync-state";
import { createVacationSettingsRepo } from "./infra/repos/vacation-settings";
import { createContactsRepo } from "./infra/repos/contacts";
import { findUncoveredKeyVersions } from "./infra/db/key-versions";
import {
  createKeyring,
  importMasterKey,
  knownKeyVersions,
  type Keyring,
} from "./modules/credentials/crypto";
import { createAuthRouter, type OidcClient } from "./modules/auth/router";
import {
  createIdTokenVerifier,
  discover,
  exchangeCode,
  remoteKeySource,
} from "./modules/auth/oidc";
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

const db = createDb(config.databaseUrl, {
  poolMax: config.dbPoolMax,
  connectTimeoutS: config.dbConnectTimeoutS,
  idleTimeoutS: config.dbIdleTimeoutS,
  statementTimeoutMs: config.dbStatementTimeoutMs,
});
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
const sieveSyncState = createSieveSyncStateRepo(db);
const vacationSettings = createVacationSettingsRepo(db);
const contacts = createContactsRepo(db);
const bootstrap = createBootstrap(config.bootstrapMode);
const jmap = config.stalwartUrl
  ? createJmapClient({
      baseUrl: config.stalwartUrl,
      forceBase: config.jmapForceBase,
      timeoutMs: config.stalwartTimeoutMs,
    })
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
      timeoutMs: config.aiTimeoutMs,
    });
  }
  return createAnthropicAiClient({
    apiKey: config.aiApiKey,
    model: config.aiModel,
    timeoutMs: config.aiTimeoutMs,
  });
}

const aiClient: AiClient | null = buildAiClient();

log("info", "ai features", { enabled: aiClient !== null, provider: config.aiProvider });

// Same OIDC client the auth router falls back to, built here so the configured
// outbound deadline reaches it (GH #165). The JWKS fetch behind createVerifier
// carries jose's own 5s `timeoutDuration` default and needs nothing from us.
const oidcClient: OidcClient = {
  discover: (issuer) => discover(issuer, undefined, config.oidcTimeoutMs),
  exchangeCode: (input) => exchangeCode({ ...input, timeoutMs: config.oidcTimeoutMs }),
  createVerifier: ({ jwksUri, issuer, clientId }) =>
    createIdTokenVerifier({ issuer, clientId, keySource: remoteKeySource(jwksUri) }),
};

if (bootstrap.enabled) {
  log("warn", "bootstrap mode active", {
    user: "bootstrap-admin",
    password: bootstrap.password,
  });
}

// Health checks wired into /api/health (GH #197). Stalwart is probed only when
// a URL is configured — an unconfigured mail backend would otherwise report the
// instance degraded forever. The SSO/OIDC provider is deliberately NOT probed
// here: discovery is an outbound call to the IdP, and hitting it on every
// health poll would reintroduce the amplification vector #194 just closed.
const checks: Record<string, HealthCheck> = { postgres: () => checkDb(db) };
if (config.stalwartUrl) {
  const stalwartUrl = config.stalwartUrl;
  checks.stalwart = () => checkStalwart({ url: stalwartUrl, timeoutMs: config.stalwartTimeoutMs });
}

const app = createApp({
  checks,
  maxBodyBytes: config.maxBodyBytes,
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
    oidcClient,
    isProduction: config.isProduction,
  }),
  setupRouter: createSetupRouter({ bootstrap, users, mailCredentials, ssoConfig, audit }),
  mailRouter: createMailRouter({
    sessions,
    mailCredentials,
    signatures,
    userPreferences,
    jmap,
    contacts,
    timeoutMs: config.stalwartTimeoutMs,
  }),
  sieveRouter: createSieveRouter({
    sessions,
    mailCredentials,
    filterRules,
    vacationSettings,
    sieveSyncState,
    jmap,
  }),
  adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig, instanceSettings }),
  aiRouter: createAiRouter({ sessions, mailCredentials, jmap, aiClient }),
  profileRouter: createProfileRouter({ sessions, users, audit }),
  contactsRouter: createContactsRouter({ sessions, contacts }),
});

// Both signals come from the validated config rather than a second read of the
// environment (GH #218): NODE_ENV has exactly one interpretation in this
// process — `config.isProduction`, the same one that forces Secure cookies —
// and STATIC_DIR is checked for being non-empty before we mount anything on it.
if (config.isProduction) {
  const root = config.staticDir;
  app.use("*", serveStatic({ root }));
  app.use("*", serveStatic({ root, path: "index.html" }));
}

// Explicit Bun.serve (rather than `export default { port, fetch }`) so we hold a
// server handle to drain in-flight requests on shutdown. Every deploy target
// runs this file as a subprocess — Dockerfile CMD, e2e/serve.ts, `bun --watch` —
// so none import a default export; the server starts on execution as before.
const server = Bun.serve({ port: config.port, fetch: app.fetch });

// Let long-lived routes (the SSE event stream) clear their own idle deadline
// without weakening Bun's global idleTimeout for every other route (GH #204).
registerServer(server);

// Graceful shutdown (GH #193). Both budgets are env-tunable; the drain budget
// bounds how long in-flight requests may finish before connections are
// force-closed, and the DB budget bounds the pool close. Defaults live in
// core/shutdown.ts and are applied by core/config.ts, which now validates both
// values instead of the local parser that used to swallow a malformed one and
// fall back to the default (GH #218).
const shutdown = createShutdown({
  server,
  sql: db,
  log,
  graceMs: config.shutdownGraceMs,
  dbTimeoutMs: config.shutdownDbTimeoutMs,
});
installProcessHandlers({ shutdown, log });

log("info", "server started", { port: server.port, bootstrapMode: config.bootstrapMode });
