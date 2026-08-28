import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type HealthCheck } from "./app";
import { loadConfig, type AppConfig } from "./core/config";
import { log } from "./core/logger";
import { registerServer } from "./core/idle-timeout";
import { createShutdown, installProcessHandlers } from "./core/shutdown";
import { createDb, DATABASE_UNAVAILABLE_CODE } from "./infra/db/client";
import { DomainError } from "./core/errors";
import { checkDb } from "./infra/db/health";
import { checkJmap } from "./infra/jmap/health";
import { createOidcReadinessCheck } from "./infra/auth/oidc-health";
import { probeJmap } from "./infra/jmap/probe";
import { migrate } from "./infra/db/migrate";
import { createAuditRepo } from "./infra/repos/audit";
import { createInstanceSettingsRepo } from "./infra/repos/instance-settings";
import { createMailCredentialsRepo } from "./infra/repos/mail-credentials";
import { createSignaturesRepo } from "./infra/repos/signatures";
import { createSsoConfigRepo } from "./infra/repos/sso-config";
import { createUserPreferencesRepo } from "./infra/repos/user-preferences";
import { createSentRecipientsRepo } from "./infra/repos/sent-recipients";
import { createSharedMailboxCopiesRepo } from "./infra/repos/shared-mailbox-copies";
import { createUsersRepo } from "./infra/repos/users";
import { createFilterRulesRepo } from "./infra/repos/filter-rules";
import { createSieveRawScriptRepo } from "./infra/repos/sieve-raw-script";
import { createSieveSyncStateRepo } from "./infra/repos/sieve-sync-state";
import { createVacationSettingsRepo } from "./infra/repos/vacation-settings";
import { createContactsRepo } from "./infra/repos/contacts";
import { createPushSubscriptionsRepo } from "./infra/repos/push-subscriptions";
import { createAiSummariesRepo } from "./infra/repos/ai-summaries";
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
import { createJmapClient, withJmapTransportErrors } from "./infra/jmap/client";
import { withDeadlineFetch } from "./core/deadline";
import { recordSharedMailboxCopy } from "./core/metrics";
import { getMailSession } from "./modules/mail/context";
import { createMailRouter } from "./modules/mail/router";
import { createSharedCopyWorker } from "./modules/mail/shared-copy/worker";
import { createSieveRouter } from "./modules/sieve/router";
import { createAdminRouter } from "./modules/admin/router";
import { createProfileRouter } from "./modules/profile/router";
import { createContactsRouter } from "./modules/contacts/router";
import { createBootstrap } from "./modules/setup/bootstrap";
import { createSetupRouter } from "./modules/setup/router";
import { createSetupCompletion } from "./modules/setup/completion";
import { createAiRouter } from "./modules/ai/router";
import { createAnthropicAiClient } from "./infra/ai/anthropic";
import { createOpenAiCompatibleClient } from "./infra/ai/openai-compatible";
import type { AiClient } from "./core/ai";
import { createPushRouter } from "./modules/push/router";
import { createWebPushSender } from "./infra/push/web-push";
import type { PushSender } from "./core/push";

let config: AppConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  log("error", "invalid configuration", { error: String(error) });
  process.exit(1);
}

// Config variables this release renamed or removed (GH #33/#34). Warned about
// on EVERY boot, one line each, naming the replacement: an alias that is
// accepted in silence is an alias nobody ever migrates off.
for (const deprecation of config.deprecations) {
  log("warn", "deprecated configuration", deprecation);
}

const db = createDb(config.databaseUrl, {
  poolMax: config.dbPoolMax,
  connectTimeoutS: config.dbConnectTimeoutS,
  idleTimeoutS: config.dbIdleTimeoutS,
  statementTimeoutMs: config.dbStatementTimeoutMs,
});

// Boot steps that talk to Postgres fail like the config load and the keyring do
// (GH #257): one JSON line naming the cause, exit 1. They used to be bare
// top-level awaits, so a wrong DATABASE_URL or a database that had not finished
// starting killed the process with a raw stack trace matching none of the causes
// docs/OPERATIONS.md lists — and the container restarted straight into the same
// trace, which is a crash loop with no diagnosis in it.
//
// A container almost always starts before its database, so a CONNECTION failure
// is retried with a bounded exponential backoff (1+2+4+8+16 = 31s of waiting)
// before giving up: enough to outlast a Postgres still opening its listener,
// short enough that a genuinely wrong DATABASE_URL still surfaces within the
// deploy window rather than hanging. Anything else — a migration that throws, a
// role without permission — is not transient and fails on the FIRST attempt:
// retrying it only delays the log line the operator needs.
const DB_BOOT_ATTEMPTS = 6;
const DB_BOOT_BACKOFF_MS = 1_000;
const DB_BOOT_BACKOFF_CAP_MS = 16_000;
const DB_UNAVAILABLE_MSG = "database unavailable at startup";

function isDbUnavailable(error: unknown): boolean {
  // createDb wraps transport failures as a 503 DomainError (infra/db/client.ts);
  // the raw socket error only reaches here if something bypasses that wrapper.
  if (error instanceof DomainError) return error.code === DATABASE_UNAVAILABLE_CODE;
  return false;
}

async function bootDbStep<T>(step: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const unavailable = isDbUnavailable(error);
      if (!unavailable || attempt >= DB_BOOT_ATTEMPTS) {
        log("error", unavailable ? DB_UNAVAILABLE_MSG : `${step} failed`, {
          step,
          attempts: attempt,
          error: String(error),
          ...(unavailable
            ? {
                hint:
                  "check DATABASE_URL, that Postgres is up and reachable from this " +
                  "container, and that its role and database exist",
              }
            : {}),
        });
        process.exit(1);
      }
      const retryInMs = Math.min(DB_BOOT_BACKOFF_MS * 2 ** (attempt - 1), DB_BOOT_BACKOFF_CAP_MS);
      log("warn", "database not reachable yet, retrying", {
        step,
        attempt,
        of: DB_BOOT_ATTEMPTS,
        retryInMs,
        error: String(error),
      });
      await Bun.sleep(retryInMs);
    }
  }
}

await bootDbStep("database migration", () =>
  migrate(db, fileURLToPath(new URL("../migrations", import.meta.url))),
);

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
const uncoveredKeyVersions = await bootDbStep("key version scan", () =>
  findUncoveredKeyVersions(db, keyring),
);
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
// #301: the idle / sliding-timeout window rides on the store; unset means no
// idle limit (only the absolute expires_at), exactly as before this knob.
const sessions = createSessionStore(db, { idleMinutes: config.sessionIdleMinutes ?? null });
const ssoConfig = createSsoConfigRepo(db, keyring);
const instanceSettings = createInstanceSettingsRepo(db);
const mailCredentials = createMailCredentialsRepo(db, keyring);
const signatures = createSignaturesRepo(db);
const userPreferences = createUserPreferencesRepo(db);
// GH #314: the addresses the user has written to (Tier A "known sender").
const sentRecipients = createSentRecipientsRepo(db);
// GH #313: cursor + dedup ledger of the automatic shared-mailbox copies.
const sharedMailboxCopies = createSharedMailboxCopiesRepo(db);
const filterRules = createFilterRulesRepo(db);
const sieveSyncState = createSieveSyncStateRepo(db);
const sieveRawScript = createSieveRawScriptRepo(db);
const vacationSettings = createVacationSettingsRepo(db);
const contacts = createContactsRepo(db);
const pushSubscriptions = createPushSubscriptionsRepo(db);
const aiSummaries = createAiSummariesRepo(db);
const bootstrap = createBootstrap(config.bootstrapMode, config.bootstrapPassword);
// #234 completion latch, built once and shared by BOTH the setup router (which
// closes itself once it reads true) and the auth router's public `/mode` (#305,
// so the login screen can learn the latch state without probing the audited
// setup endpoint). One instance so its in-memory one-way latch is consistent.
const setupCompletion = createSetupCompletion({ users, ssoConfig });
const jmap = config.jmapUrl
  ? createJmapClient({
      baseUrl: config.jmapUrl,
      urlMode: config.jmapUrlMode,
      authMode: config.jmapAuthMode,
      timeoutMs: config.jmapTimeoutMs,
    })
  : null;

log("info", "mail proxy", {
  configured: jmap !== null,
  urlMode: config.jmapUrlMode,
  authMode: config.jmapAuthMode,
});

// GH #152: the "verified sender" badge is only trustworthy when this process
// can tell its own receiving MTA's Authentication-Results header apart from one
// a sender forged, which needs JMAP_AUTHSERV_ID. Without it, sender-authenticity
// is fail-safe OFF: every verdict is "unknown" and no message ever asserts a
// verified sender (see modules/mail/sender-auth.ts). Warned loudly, once, at
// boot — but only when a mail backend is actually configured, since the badge is
// moot otherwise — so this is a deliberate state and not a silent gap.
if (config.jmapUrl && !config.jmapAuthServId) {
  log(
    "warn",
    "sender authenticity disabled: set JMAP_AUTHSERV_ID (your MTA's Authentication-Results authserv-id) to enable the verified-sender badge; until then every verdict is 'unknown'",
    {},
  );
}

// Boot-time reachability probe (GH #188). Deliberately NOT awaited: the mail
// provider and this process usually start together, so blocking the listener on
// a dependency that may still be coming up would turn a normal ordering race
// into a slow boot — and the probe is diagnostic, not a precondition. It never
// throws; it logs what it found, including the URL this process will really
// call once JMAP_URL_MODE has been applied.
if (config.jmapUrl) {
  void probeJmap({
    url: config.jmapUrl,
    urlMode: config.jmapUrlMode,
    authMode: config.jmapAuthMode,
    timeoutMs: config.jmapTimeoutMs,
  });
}

// GH #313: the background worker that copies new shared-mailbox mail into
// each opted-in member's own inbox (modules/mail/shared-copy/). Built only
// when a JMAP provider is configured — there is nothing to watch otherwise —
// and unless the operator switched it off; with no opt-ins it runs no cycle
// and opens no subscription, so it is inert by default in every other sense.
// Its session lookup is the same cached one requireMail uses, so a member's
// eviction (logout, credential rotation) reaches the worker too.
//
// The subscription's fetch is dressed the same way the SSE proxy's is
// (modules/mail/router.ts): the outbound deadline covers time-to-headers
// only, so the long-lived stream stays open while a provider that accepts and
// never answers still fails fast, and a transport failure reads as the
// dependency being down rather than as an internal error.
function buildSharedCopyWorker() {
  if (!jmap || !config.sharedMailboxCopyEnabled) return null;
  const jmapClient = jmap;
  return createSharedCopyWorker({
    delivery: {
      jmap: jmapClient,
      copies: sharedMailboxCopies,
      getMailSession: (member) => getMailSession({ jmap: jmapClient, mailCredentials }, member),
      onCopyResult: recordSharedMailboxCopy,
    },
    listOptIns: () => userPreferences.listSharedMailboxCopyOptIns(),
    listOptInMembership: () => userPreferences.listSharedMailboxCopyOptInMembership(),
    pollMs: config.sharedMailboxCopyPollMs,
    fetchFn: withJmapTransportErrors(withDeadlineFetch(fetch, "stalwart", config.jmapTimeoutMs)),
    authMode: config.jmapAuthMode,
  });
}

const sharedCopyWorker = buildSharedCopyWorker();

log("info", "shared mailbox copies", {
  enabled: sharedCopyWorker !== null,
  configured: config.sharedMailboxCopyEnabled,
  pollMs: config.sharedMailboxCopyPollMs,
});

// Software-level default-safe gate: AI features are inert unless explicitly
// enabled AND an API key is configured. See docs/ARCHITECTURE.md ("IA —
// funciones opt-in") — any further network-level restriction is a
// deployment-specific choice outside this software's contract.
//
// Provider selection: "openai-compat" covers any provider speaking the
// OpenAI-compatible `/v1/chat/completions` API (MiniMax, Kimi/Moonshot, or a
// self-hosted Ollama/vLLM/LiteLLM server) via a single adapter configured
// with `aiBaseUrl`. Anything else (default) uses the Anthropic adapter.
// Per-task model selection (GH #310): summarize/summarizeThread and draftReply
// can each run on their own model, resolved here from AI_MODEL_SUMMARIZE /
// AI_MODEL_DRAFT, each falling back to the shared `config.aiModel` (AI_MODEL)
// when unset. Summaries do well on a cheaper/smaller model; the draft benefits
// from a stronger one.
function buildAiClient(): AiClient | null {
  if (!config.aiEnabled || !config.aiApiKey) return null;
  const summarizeModel = config.aiModelSummarize ?? config.aiModel;
  const draftModel = config.aiModelDraft ?? config.aiModel;
  const models = { summarize: summarizeModel, draft: draftModel };
  if (config.aiProvider === "openai-compat") {
    if (!config.aiBaseUrl) {
      log("warn", "ai provider openai-compat requires aiBaseUrl (AI_BASE_URL); AI features disabled", {});
      return null;
    }
    return createOpenAiCompatibleClient({
      apiKey: config.aiApiKey,
      models,
      baseUrl: config.aiBaseUrl,
      timeoutMs: config.aiTimeoutMs,
    });
  }
  return createAnthropicAiClient({
    apiKey: config.aiApiKey,
    models,
    timeoutMs: config.aiTimeoutMs,
  });
}

const aiClient: AiClient | null = buildAiClient();

// Model names are configuration, not secrets, so they are safe to log — this
// lets an operator confirm per-task selection (GH #310) took effect. API keys
// are never logged.
log("info", "ai features", {
  enabled: aiClient !== null,
  provider: config.aiProvider,
  summarizeModel: config.aiModelSummarize ?? config.aiModel,
  draftModel: config.aiModelDraft ?? config.aiModel,
});

// #294 (delivery slice): Web Push is inert until the full VAPID trio is set —
// same default-safe gate as buildAiClient above. A partially configured trio is
// treated as "off" (and warned about, since it is almost certainly a mistake)
// rather than refusing the boot: push is a non-critical extra, so a missing key
// must not take the whole server down the way a missing MASTER_KEY does.
function buildPushClient(): PushSender | null {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = config;
  if (!vapidPublicKey && !vapidPrivateKey && !vapidSubject) return null;
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    log("warn", "push features need VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together; push disabled", {});
    return null;
  }
  return createWebPushSender({
    publicKey: vapidPublicKey,
    privateKey: vapidPrivateKey,
    subject: vapidSubject,
  });
}

const pushClient: PushSender | null = buildPushClient();

log("info", "push features", { enabled: pushClient !== null });

// Same OIDC client the auth router falls back to, built here so the configured
// outbound deadline reaches it (GH #165). The JWKS fetch behind createVerifier
// carries jose's own 5s `timeoutDuration` default and needs nothing from us.
const oidcClient: OidcClient = {
  discover: (issuer) => discover(issuer, undefined, config.oidcTimeoutMs),
  exchangeCode: (input) => exchangeCode({ ...input, timeoutMs: config.oidcTimeoutMs }),
  createVerifier: ({ jwksUri, issuer, clientId }) =>
    createIdTokenVerifier({ issuer, clientId, keySource: remoteKeySource(jwksUri) }),
};

// The warning stays — an instance running with the break-glass door open is
// worth a line in every startup — but the credential does NOT (GH #235). It
// used to be logged here in plaintext at `warn`, which put a working admin
// password into `docker logs`, into whatever aggregator collects them, and into
// the retention window of both, valid for the whole life of the process and
// readable by everyone with log access. The operator sets `BOOTSTRAP_PASSWORD`
// now (modules/setup/bootstrap.ts), so they already have it and this process
// has nothing to deliver.
if (bootstrap.enabled) {
  log("warn", "bootstrap mode active", { user: "bootstrap-admin" });
}

// Health checks wired into /api/health (GH #197). The mail provider is probed
// only when a URL is configured — an unconfigured mail backend would otherwise
// report the instance degraded forever.
//
// The check keeps the key `stalwart` in the published /api/health body and in
// `cefiro_dependency_up{dependency="stalwart"}` — operators' dashboards and
// alerts are keyed on it, and GH #33 renames names in code, not wire labels.
const checks: Record<string, HealthCheck> = { postgres: () => checkDb(db) };
if (config.jmapUrl) {
  const jmapUrl = config.jmapUrl;
  // The probe's budget travels WITH the request (GH #242): overrunning it now
  // cancels the fetch instead of leaving it running behind an answer that has
  // already been sent. See core/health.ts.
  checks.stalwart = (signal) =>
    checkJmap({ url: jmapUrl, timeoutMs: config.jmapTimeoutMs, signal });
}
// The SSO/OIDC provider (GH #281). Regular users log in ONLY through SSO
// (modules/auth/router.ts), so an SSO-configured instance whose IdP is
// unreachable cannot serve logins — readiness must reflect that and let the LB
// drain it, which /api/health used to hide by reporting `ok`. Probed with a
// dedicated long healthy-cache (infra/auth/oidc-health.ts) so it cannot
// reintroduce the #194 amplification the earlier "do not probe OIDC" note
// guarded against: the IdP sees at most one discovery per cache window however
// often /api/health is polled. When no SSO is configured (read fresh each
// probe) the check is a no-op that reports healthy. The AI provider is
// intentionally NOT a readiness dependency — it is opt-in and non-critical, so
// draining an instance over it would be a false negative.
checks.oidc = createOidcReadinessCheck({ ssoConfig, timeoutMs: config.oidcTimeoutMs });

const app = createApp({
  checks,
  maxBodyBytes: config.maxBodyBytes,
  // From the validated schema, not a second read of the environment (GH #259).
  metricsToken: config.metricsToken,
  // The proxy contract every per-IP ceiling is keyed on (GH #238).
  trustedProxyHops: config.trustedProxyHops,
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
    completion: setupCompletion,
    trustedProxyHops: config.trustedProxyHops,
  }),
  setupRouter: createSetupRouter({
    bootstrap,
    users,
    mailCredentials,
    ssoConfig,
    audit,
    completion: setupCompletion,
    trustedProxyHops: config.trustedProxyHops,
  }),
  mailRouter: createMailRouter({
    sessions,
    mailCredentials,
    signatures,
    userPreferences,
    jmap,
    contacts,
    sentRecipients,
    // GH #313: the manual copy button writes into the same ledger the copy
    // worker reads, so a message the member pulled themselves is not
    // delivered to them again by the next cycle.
    sharedMailboxCopies,
    // GH #337: the /events tap is where Web Push is emitted from — an Email
    // state advance on this user's subscription becomes one push per device.
    // `pushClient` is null when VAPID is unconfigured, which turns the emitter
    // off without turning the tap off.
    pushClient,
    pushSubscriptions,
    timeoutMs: config.jmapTimeoutMs,
    // The raw-fetch routes (SSE, blob up/download) must present the mailbox
    // credential the same way the JMAP client does, or `bearer` would work for
    // the API and 401 on every attachment (GH #35).
    authMode: config.jmapAuthMode,
    // GH #152: the authserv-id whose Authentication-Results header is trusted
    // for the sender-authenticity badge. Undefined = fail-safe "unknown".
    authServId: config.jmapAuthServId,
  }),
  sieveRouter: createSieveRouter({
    sessions,
    mailCredentials,
    filterRules,
    vacationSettings,
    sieveSyncState,
    sieveRawScript,
    jmap,
  }),
  adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig, instanceSettings }),
  aiRouter: createAiRouter({ sessions, mailCredentials, jmap, aiClient, aiSummaries }),
  pushRouter: createPushRouter({
    sessions,
    pushSubscriptions,
    pushClient,
    vapidPublicKey: config.vapidPublicKey ?? null,
  }),
  profileRouter: createProfileRouter({ sessions, users, audit }),
  contactsRouter: createContactsRouter({ sessions, contacts }),
});

// Mount the SPA whenever a built one is actually present, not on NODE_ENV
// (GH #288). `config.staticDir` is resolved the way hono/bun's serveStatic
// resolves `root` — relative to the process cwd, or the absolute path the
// Docker image sets via STATIC_DIR — so probing `<staticDir>/index.html` on the
// same base answers the only question that matters: is there a build to serve?
// A dev source checkout has none (Vite serves the SPA on its own port), so this
// stays unmounted there regardless of NODE_ENV; the Docker image points
// STATIC_DIR at the build, so it mounts in every environment. STATIC_DIR being
// non-empty is still guaranteed by the config schema (GH #218).
const root = config.staticDir;
if (existsSync(join(root, "index.html"))) {
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

// GH #313: only once the listener is up — the worker's first pass talks to
// Postgres and to the provider, and a boot that fails there must fail with the
// server already answering /api/health/live, not before it.
sharedCopyWorker?.start();

// Graceful shutdown (GH #193). Both budgets are env-tunable; the drain budget
// bounds how long in-flight requests may finish before connections are
// force-closed, and the DB budget bounds the pool close. Defaults live in
// core/shutdown.ts and are applied by core/config.ts, which now validates both
// values instead of the local parser that used to swallow a malformed one and
// fall back to the default (GH #218). The copy worker (GH #313) is stopped
// FIRST, before the drain, so no cycle starts a copy against a closing pool.
const shutdown = createShutdown({
  server,
  sql: db,
  log,
  graceMs: config.shutdownGraceMs,
  dbTimeoutMs: config.shutdownDbTimeoutMs,
  stopWorkers: sharedCopyWorker ? () => sharedCopyWorker.stop() : undefined,
});
installProcessHandlers({ shutdown, log });

log("info", "server started", { port: server.port, bootstrapMode: config.bootstrapMode });
