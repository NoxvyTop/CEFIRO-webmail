import { z } from "zod";
import { DEFAULT_TRUSTED_PROXY_HOPS } from "./client-ip";
import {
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_JMAP_TIMEOUT_MS,
  DEFAULT_OIDC_TIMEOUT_MS,
} from "./deadline";
import {
  DEFAULT_DB_TIMEOUT_MS as DEFAULT_SHUTDOWN_DB_TIMEOUT_MS,
  DEFAULT_GRACE_MS as DEFAULT_SHUTDOWN_GRACE_MS,
} from "./shutdown";
import {
  DEFAULT_DB_CONNECT_TIMEOUT_S,
  DEFAULT_DB_IDLE_TIMEOUT_S,
  DEFAULT_DB_POOL_MAX,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
} from "../infra/db/client";
import { masterKeyWeakness } from "../modules/credentials/crypto";

const masterKeySchema = z.string().length(44);

// Where the built SPA is served from in production (src/index.ts). The default
// is the path relative to apps/server that a source checkout produces; the
// Docker image overrides it with STATIC_DIR (see Dockerfile).
export const DEFAULT_STATIC_DIR = "../web/dist";

// Environments where a weak MASTER_KEY is tolerated (GH #223). Everything else
// — production, staging, or any other name an operator invents — must carry a
// generated key. See the superRefine below for the full reasoning.
const WEAK_MASTER_KEY_ENVS = new Set(["development", "test"]);

// Global request-body ceiling (GH #195). A few MB rather than the "few hundred
// KB" a plain JSON API would need, because send/drafts/signatures legitimately
// carry inline images embedded as base64 data: URIs directly in the body/
// signature HTML (see apps/web RichTextEditor MAX_IMAGE_BYTES = 1 MiB, and
// compose's uncapped htmlBody) — a sub-MB cap would 413 a normal email or
// signature with a single inline image. 2 MB is the smallest small-integer-MB
// cap that still admits one max-size inline image plus the JSON/HTML envelope,
// the same sizing the profile avatar limit already uses. It bounds memory
// (the "buffer a 100 MB body" vector this closes) without breaking real bodies.
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

// Shortest break-glass credential `BOOTSTRAP_MODE=true` will boot with (GH
// #235). It is the length of the secret this server used to generate for the
// operator — 18 random bytes rendered base64url — so the move from "the process
// mints it and prints it to the log" to "the operator sets it" cannot quietly
// become a downgrade in strength. It guards the bootstrap login AND the setup
// API, both reachable unauthenticated, so a memorable password is not an
// option; the runbook says to generate one.
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 24;

// A deadline of 0 or a fraction of a millisecond would abort every outbound
// call before it started, so those are configuration errors, not tuning.
const timeoutMsSchema = z.coerce.number().int().positive();

// Pool sizes and DB timeouts share the same shape as the outbound deadlines: a
// zero, negative, or fractional pool/timeout is a misconfiguration, not tuning.
const positiveIntSchema = z.coerce.number().int().positive();

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  databaseUrl: z.string().min(1),
  masterKey: masterKeySchema,
  // Version stamped on every row `masterKey` encrypts. Deployments that never
  // rotated leave it at 1, which is what the schema already defaults every
  // `key_version` column to — so they need no configuration change.
  masterKeyVersion: z.coerce.number().int().positive().default(1),
  // Retired keys still needed to read rows that have not been re-encrypted
  // yet. A retired key may only be dropped once no row carries its version.
  previousMasterKeys: z
    .array(z.object({ version: z.number().int().positive(), key: masterKeySchema }))
    .default([]),
  appUrl: z.string().url(),
  // Deployment environment. Load-bearing via WEAK_MASTER_KEY_ENVS below: any
  // value outside the {development,test} allowlist refuses a weak MASTER_KEY
  // (GH #223). It used to ALSO force Secure cookies in production (GH #196), but
  // that coupling was removed in GH #288 — Secure is now derived per request
  // from the effective scheme (see modules/auth/router.ts), correct behind both
  // an HTTP and an HTTPS edge. Defaults to development so local/test runs over
  // http keep working unchanged.
  nodeEnv: z.string().min(1).default("development"),
  bootstrapMode: z.boolean(),
  // The break-glass credential, supplied by the operator (GH #235). Optional
  // here and required by the superRefine below only when `bootstrapMode` is on,
  // because it is meaningless otherwise: with the flag off there is no
  // bootstrap login and no setup API for it to unlock. See
  // modules/setup/bootstrap.ts for why the process no longer mints its own.
  bootstrapPassword: z.string().optional(),
  sessionTtlHours: z.coerce.number().int().positive().default(12),
  // Base URL of the JMAP provider — Stalwart in our own deployments, but the
  // protocol is RFC 8620 and so is this client, so the name is the ROLE (GH
  // #33). `STALWART_URL` is still accepted; see RENAMED_ENV_VARS.
  jmapUrl: z.string().url().optional(),
  // What to do with the URLs the provider advertises in its JMAP session
  // (apiUrl/uploadUrl/downloadUrl/eventSourceUrl) — GH #34, design GH #188.
  // `rewrite` is the default: nearly every deployment reaches the provider by
  // a different path than the one it advertises, and trusting the
  // advertisement was the single largest source of "discovery works, every
  // call after it 502s". See infra/jmap/client.ts for the full contract.
  jmapUrlMode: z.enum(["rewrite", "trust"]).default("rewrite"),
  // How the mailbox credential is presented to the provider (GH #35). Stalwart
  // and most self-hosted providers want Basic; token/OAuth providers want
  // Bearer, and until this existed they simply could not be talked to.
  jmapAuthMode: z.enum(["basic", "bearer"]).default("basic"),
  // GH #152: the authserv-id (RFC 8601 §5) that this deployment's own
  // receiving MTA — Stalwart, in our deployments — stamps as the first token
  // of every `Authentication-Results` header it adds. It is what tells our own
  // trust header apart from one a sender forged: an Authentication-Results
  // header is trusted for the "verified sender" badge ONLY when its authserv-id
  // matches this value; any other is attacker-suppliable and is ignored (see
  // modules/mail/sender-auth.ts).
  //
  // Optional, and fail-safe by design: with it unset, NO header can be
  // attributed to our own MTA, so every verdict degrades to "unknown" and no
  // message ever shows a "verified sender" badge. That is deliberate — a badge
  // that cannot be forged is worth more than one that can — and index.ts warns
  // loudly, once, at boot while it is unset. It CANNOT be guessed on the
  // deployment's behalf (a wrong guess would trust the wrong header), so it has
  // no default.
  jmapAuthServId: z.string().min(1).optional(),
  // Outbound deadlines (GH #165). One per upstream rather than one shared
  // number: see core/deadline.ts for why each default is what it is. Every one
  // has a default, so no deployment has to set anything.
  jmapTimeoutMs: timeoutMsSchema.default(DEFAULT_JMAP_TIMEOUT_MS),
  aiTimeoutMs: timeoutMsSchema.default(DEFAULT_AI_TIMEOUT_MS),
  oidcTimeoutMs: timeoutMsSchema.default(DEFAULT_OIDC_TIMEOUT_MS),
  // Postgres pool + timeouts (GH #191). Every DB dependency inherits the same
  // fail-fast discipline as the outbound deadlines above: without these, a slow
  // or locked query pinned a pooled connection forever and stalled the service.
  // Defaults (and the postgres option semantics) live beside createDb in
  // infra/db/client.ts, which also applies them when this config is not passed.
  dbPoolMax: positiveIntSchema.default(DEFAULT_DB_POOL_MAX),
  dbConnectTimeoutS: positiveIntSchema.default(DEFAULT_DB_CONNECT_TIMEOUT_S),
  dbIdleTimeoutS: positiveIntSchema.default(DEFAULT_DB_IDLE_TIMEOUT_S),
  dbStatementTimeoutMs: positiveIntSchema.default(DEFAULT_DB_STATEMENT_TIMEOUT_MS),
  // AI features (summarize / draft-with-AI) are software-level off by default:
  // aiEnabled defaults to false and any call must also have an aiApiKey, or the
  // domain layer fails fast with `ai_disabled` before attempting any network call.
  // Any additional network-level restriction (egress, firewalling) is a
  // deployment-specific concern outside this software's contract.
  aiEnabled: z.boolean().default(false),
  aiProvider: z.string().min(1).default("anthropic"),
  aiApiKey: z.string().min(1).optional(),
  aiModel: z.string().min(1).default("claude-opus-4-8"),
  // API root for OpenAI-compatible providers (MiniMax, Kimi/Moonshot, a local
  // Ollama/vLLM/LiteLLM server, ...), INCLUDING any `/v1` segment the
  // provider requires (OpenAI-SDK convention). Only consulted when
  // aiProvider is "openai-compat" — see infra/ai/openai-compatible.ts.
  aiBaseUrl: z.string().min(1).optional(),
  // Global request-body ceiling in bytes (GH #195). A zero/negative/fractional
  // limit is a misconfiguration, not tuning — same shape as the pool sizes.
  maxBodyBytes: positiveIntSchema.default(DEFAULT_MAX_BODY_BYTES),
  // Graceful-shutdown budgets (GH #193), validated here rather than parsed ad
  // hoc at the call site (GH #218). They used to go through a local
  // `positiveIntEnv` in index.ts that silently swallowed a malformed value and
  // fell back to the default — so a fat-fingered SHUTDOWN_GRACE_MS in
  // production quietly changed the drain budget instead of refusing to boot,
  // the one thing every other knob here does. Same shape as the pool sizes: a
  // zero, negative or fractional budget is a misconfiguration, not tuning.
  shutdownGraceMs: positiveIntSchema.default(DEFAULT_SHUTDOWN_GRACE_MS),
  shutdownDbTimeoutMs: positiveIntSchema.default(DEFAULT_SHUTDOWN_DB_TIMEOUT_MS),
  // Directory the production build serves the SPA from (GH #218). Read from
  // the environment at the call site before, which meant an empty STATIC_DIR
  // was accepted and served nothing.
  staticDir: z.string().min(1).default(DEFAULT_STATIC_DIR),
  // Bearer token that unlocks /metrics (GH #208), validated here rather than
  // read from the environment inside createApp (GH #259) — the same defect
  // GH #218 closed for four other variables. Optional, and deliberately so:
  // with no token the endpoint is not registered at all. But the read had to
  // move here, because a MISSPELLED variable name produced exactly the same
  // 404 as "metrics are deliberately off", so monitoring could vanish with
  // nothing anywhere saying it had. Now the value a deployment configures
  // travels through the one schema the rest of the contract goes through, and
  // `min(1)` refuses an empty string instead of unlocking an endpoint with it.
  metricsToken: z.string().min(1).optional(),
  // How many proxies append to `X-Forwarded-For` between the internet and this
  // process (GH #238). Load-bearing for every per-IP ceiling and for the audit
  // `ip` column: the client is read by counting this many entries from the
  // RIGHT of the chain, so a caller cannot choose their own rate-limit key by
  // prepending hops. See core/client-ip.ts for the attribution rule and
  // docs/OPERATIONS.md for what the proxy has to send.
  //
  // Zero is legal and means "trust nothing in that header" — correct for a
  // process exposed directly, at the price of every ceiling becoming global.
  // Anything negative or fractional is a misconfiguration, not tuning, so this
  // is the one numeric knob here that is nonnegative rather than positive.
  trustedProxyHops: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_TRUSTED_PROXY_HOPS),
}).superRefine((config, ctx) => {
  // GH #223: MASTER_KEY was only ever checked for LENGTH, so the key shipped in
  // docker-compose.dev.yml (`dev-master-key-dev-master-key-01`, base64) passed
  // validation unchanged in production — and it decrypts every stored mailbox
  // credential and the SSO client secret.
  //
  // The check is scoped to non-development environments rather than applied
  // everywhere, deliberately: the dev compose file has to keep booting with a
  // key a developer can read in a diff, and the test suite builds keys out of
  // fixed bytes. Making the exemption an allowlist (`development`, `test`)
  // instead of `!isProduction` means a deployment that calls itself `staging`,
  // `prod` or anything else is covered too — the only way to opt out is to
  // declare, explicitly, that this is not a real environment.
  //
  // Retired keys in MASTER_KEY_PREVIOUS are NOT checked: they exist to read
  // rows sealed before a rotation, so refusing them would leave a deployment
  // rotating AWAY from a weak key unable to boot — exactly backwards. Rotating
  // is the supported way out (see docs/ARCHITECTURE.md).
  if (!WEAK_MASTER_KEY_ENVS.has(config.nodeEnv)) {
    const weakness = masterKeyWeakness(config.masterKey);
    if (weakness) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["masterKey"],
        message:
          `MASTER_KEY is unusable with NODE_ENV=${config.nodeEnv}: ${weakness}. ` +
          "Generate one with `bun apps/server/scripts/generate-master-key.ts`; " +
          "never copy the key from docker-compose.dev.yml or any example.",
      });
    }
  }
  // GH #235: `BOOTSTRAP_MODE=true` opens an unauthenticated login and the whole
  // setup API on one shared secret. That secret is now the operator's to set,
  // so a bootstrap boot without a usable one must not start — the alternative,
  // starting with the door open and no key, is the worst of both. Refusing at
  // boot is the same contract every other required variable here has: a
  // half-configured deployment fails while someone is watching it.
  if (config.bootstrapMode) {
    const password = config.bootstrapPassword ?? "";
    if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bootstrapPassword"],
        message:
          "BOOTSTRAP_MODE=true requires BOOTSTRAP_PASSWORD, at least " +
          `${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters long. Generate one ` +
          "(`openssl rand -base64 24`), keep it in the same secret store as " +
          "MASTER_KEY, and remove it when you set BOOTSTRAP_MODE back to false.",
      });
    }
  }
  const declared = new Set<number>();
  for (const previous of config.previousMasterKeys) {
    if (previous.version === config.masterKeyVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousMasterKeys"],
        message: `MASTER_KEY_PREVIOUS declares version ${previous.version}, which is the current MASTER_KEY_VERSION`,
      });
    }
    if (declared.has(previous.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousMasterKeys"],
        message: `MASTER_KEY_PREVIOUS declares version ${previous.version} more than once`,
      });
    }
    declared.add(previous.version);
  }
});

/**
 * One "your configuration still uses the old name" line, collected while
 * parsing and logged once by index.ts.
 *
 * Returned rather than logged from here on purpose: `loadConfig` is a pure
 * function the whole test suite calls, and a schema parser that writes to the
 * log stream as a side effect would make every one of those calls noisy while
 * making the notices themselves untestable.
 */
export type ConfigDeprecation = { variable: string; message: string };

// `isProduction` is derived once here rather than re-deriving `nodeEnv ===
// "production"` at each call site, so the production signal has a single source.
export type AppConfig = z.infer<typeof configSchema> & {
  isProduction: boolean;
  deprecations: ConfigDeprecation[];
};

/**
 * The GH #33 renames, old name → new name.
 *
 * Compatibility decision: the old names KEEP WORKING, with a warning, rather
 * than being cut. A deployment upgrades this image by pulling a tag; if the
 * rename were total, that pull would boot a server with no mail backend
 * configured (`JMAP_URL` unset is a legal, silent state — the mail routes just
 * answer 503 `mail_not_configured`) and no configuration error to look at. A
 * breaking change that fails LOUDLY would be defensible; one that degrades
 * quietly is not, and this one degrades quietly. The alias is the cheap half of
 * the deal; the loud half is the warning below, which names the exact new
 * variable, in every boot, until the operator renames it.
 *
 * `JMAP_FORCE_BASE` is deliberately NOT here: see REMOVED_ENV_VARS.
 */
const RENAMED_ENV_VARS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "STALWART_URL", to: "JMAP_URL" },
  { from: "STALWART_TIMEOUT_MS", to: "JMAP_TIMEOUT_MS" },
];

/**
 * Removed outright, with the replacement spelled out (GH #34, design GH #188).
 *
 * `JMAP_FORCE_BASE` gets no alias because it CANNOT have an honest one: it was
 * a boolean whose off state was the default, and its replacement is a mode
 * whose default is the opposite behaviour. Silently mapping `false` to `trust`
 * would preserve a default this design deliberately reversed; silently mapping
 * it to `rewrite` would ignore an operator who wrote the word `false`. So it is
 * ignored and announced, which is the only reading that cannot be wrong twice.
 */
const REMOVED_ENV_VARS: ReadonlyArray<{ variable: string; message: string }> = [
  {
    variable: "JMAP_FORCE_BASE",
    message:
      "JMAP_FORCE_BASE has been removed and is IGNORED. Its replacement is " +
      "JMAP_URL_MODE: `rewrite` (the new default — what JMAP_FORCE_BASE=true " +
      "used to do) or `trust` (what JMAP_FORCE_BASE=false used to do). If this " +
      "deployment relied on the advertised URLs being used verbatim, set " +
      "JMAP_URL_MODE=trust; otherwise delete the variable.",
  },
];

/**
 * Reads a renamed variable, preferring the new name, and records a deprecation
 * whenever the old one is present at all.
 */
function readRenamed(
  env: Record<string, string | undefined>,
  from: string,
  to: string,
  deprecations: ConfigDeprecation[],
): string | undefined {
  const current = env[to] || undefined;
  const legacy = env[from] || undefined;
  if (legacy === undefined) return current;
  if (current !== undefined) {
    deprecations.push({
      variable: from,
      message: `${from} is deprecated AND ${to} is set; ${from} is ignored. Remove ${from}.`,
    });
    return current;
  }
  deprecations.push({
    variable: from,
    message: `${from} is deprecated: rename it to ${to}. It is still read today and will stop being read in a future release.`,
  });
  return legacy;
}

/** Every deprecation/removal notice this environment earns. */
function collectDeprecations(
  env: Record<string, string | undefined>,
): ConfigDeprecation[] {
  const deprecations: ConfigDeprecation[] = [];
  for (const removed of REMOVED_ENV_VARS) {
    if (env[removed.variable]) deprecations.push(removed);
  }
  return deprecations;
}

/**
 * `MASTER_KEY_PREVIOUS` lists retired master keys as `version:base64key`,
 * comma separated — e.g. `1:AAA...,2:BBB...`. Malformed versions are left as
 * NaN/0 on purpose so the schema reports them alongside every other issue.
 */
function parsePreviousMasterKeys(
  raw: string | undefined,
): { version: number; key: string }[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return {
        version: separator < 0 ? Number.NaN : Number(entry.slice(0, separator)),
        key: entry.slice(separator + 1),
      };
    });
}

export function loadConfig(
  env: Record<string, string | undefined>,
): AppConfig {
  const deprecations = collectDeprecations(env);
  const renamed = new Map(
    RENAMED_ENV_VARS.map(({ from, to }) => [to, readRenamed(env, from, to, deprecations)]),
  );
  const parsed = configSchema.parse({
    port: env.PORT ?? undefined,
    databaseUrl: env.DATABASE_URL,
    masterKey: env.MASTER_KEY,
    masterKeyVersion: env.MASTER_KEY_VERSION ?? undefined,
    previousMasterKeys: parsePreviousMasterKeys(env.MASTER_KEY_PREVIOUS),
    appUrl: env.APP_URL,
    nodeEnv: env.NODE_ENV || undefined,
    bootstrapMode: env.BOOTSTRAP_MODE === "true" || env.BOOTSTRAP_MODE === "1",
    // Not trimmed: leading/trailing whitespace is a legitimate part of a
    // generated secret, and silently rewriting the credential an operator
    // configured would make it fail to verify with nothing to look at.
    bootstrapPassword: env.BOOTSTRAP_PASSWORD || undefined,
    sessionTtlHours: env.SESSION_TTL_HOURS ?? undefined,
    jmapUrl: renamed.get("JMAP_URL"),
    // Lower-cased before the enum so `JMAP_URL_MODE=Rewrite` is the mode the
    // operator plainly meant. An unknown word is NOT normalised away: it fails
    // the enum and refuses the boot, because "I set a mode and got the other
    // one" is exactly the class of silent misconfiguration this replaces.
    jmapUrlMode: env.JMAP_URL_MODE?.trim().toLowerCase() || undefined,
    jmapAuthMode: env.JMAP_AUTH_MODE?.trim().toLowerCase() || undefined,
    // Trimmed before validation, like METRICS_TOKEN above: a stray space in a
    // compose file is not an authserv-id and must not accidentally configure
    // one — that would trust a header no server ever stamped. NOT lower-cased
    // here: the authserv-id keeps the operator's spelling, and the comparison
    // in sender-auth.ts is case-insensitive on both sides.
    jmapAuthServId: env.JMAP_AUTHSERV_ID?.trim() || undefined,
    jmapTimeoutMs: renamed.get("JMAP_TIMEOUT_MS"),
    aiTimeoutMs: env.AI_TIMEOUT_MS || undefined,
    oidcTimeoutMs: env.OIDC_TIMEOUT_MS || undefined,
    dbPoolMax: env.DB_POOL_MAX || undefined,
    dbConnectTimeoutS: env.DB_CONNECT_TIMEOUT_S || undefined,
    dbIdleTimeoutS: env.DB_IDLE_TIMEOUT_S || undefined,
    dbStatementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS || undefined,
    aiEnabled: env.AI_ENABLED === "true" || env.AI_ENABLED === "1",
    aiProvider: env.AI_PROVIDER || undefined,
    aiApiKey: env.AI_API_KEY || undefined,
    aiModel: env.AI_MODEL || undefined,
    aiBaseUrl: env.AI_BASE_URL || undefined,
    maxBodyBytes: env.MAX_BODY_BYTES || undefined,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS || undefined,
    shutdownDbTimeoutMs: env.SHUTDOWN_DB_TIMEOUT_MS || undefined,
    staticDir: env.STATIC_DIR || undefined,
    // Trimmed before validation: an operator who writes `METRICS_TOKEN=` (or a
    // stray space) in a compose file has not configured a token, and must not
    // get the endpoint unlocked by whitespace.
    metricsToken: env.METRICS_TOKEN?.trim() || undefined,
    trustedProxyHops: env.TRUSTED_PROXY_HOPS || undefined,
  });
  return { ...parsed, isProduction: parsed.nodeEnv === "production", deprecations };
}
