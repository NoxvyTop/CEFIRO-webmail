import { z } from "zod";
import {
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_OIDC_TIMEOUT_MS,
  DEFAULT_STALWART_TIMEOUT_MS,
} from "./deadline";
import {
  DEFAULT_DB_CONNECT_TIMEOUT_S,
  DEFAULT_DB_IDLE_TIMEOUT_S,
  DEFAULT_DB_POOL_MAX,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
} from "../infra/db/client";

const masterKeySchema = z.string().length(44);

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
  bootstrapMode: z.boolean(),
  sessionTtlHours: z.coerce.number().int().positive().default(12),
  stalwartUrl: z.string().url().optional(),
  // Some reverse-proxied Stalwart deployments advertise an internal or
  // security-restricted origin in the JMAP session (apiUrl/uploadUrl/etc.)
  // that differs from the reachable base URL. Off by default: existing
  // Stalwart setups that advertise a correct, reachable origin see no change.
  jmapForceBase: z.boolean().default(false),
  // Outbound deadlines (GH #165). One per upstream rather than one shared
  // number: see core/deadline.ts for why each default is what it is. Every one
  // has a default, so no deployment has to set anything.
  stalwartTimeoutMs: timeoutMsSchema.default(DEFAULT_STALWART_TIMEOUT_MS),
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
}).superRefine((config, ctx) => {
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

export type AppConfig = z.infer<typeof configSchema>;

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
  return configSchema.parse({
    port: env.PORT ?? undefined,
    databaseUrl: env.DATABASE_URL,
    masterKey: env.MASTER_KEY,
    masterKeyVersion: env.MASTER_KEY_VERSION ?? undefined,
    previousMasterKeys: parsePreviousMasterKeys(env.MASTER_KEY_PREVIOUS),
    appUrl: env.APP_URL,
    bootstrapMode: env.BOOTSTRAP_MODE === "true" || env.BOOTSTRAP_MODE === "1",
    sessionTtlHours: env.SESSION_TTL_HOURS ?? undefined,
    stalwartUrl: env.STALWART_URL || undefined,
    jmapForceBase: env.JMAP_FORCE_BASE === "true" || env.JMAP_FORCE_BASE === "1",
    stalwartTimeoutMs: env.STALWART_TIMEOUT_MS || undefined,
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
  });
}
