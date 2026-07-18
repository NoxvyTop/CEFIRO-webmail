import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  databaseUrl: z.string().min(1),
  masterKey: z.string().length(44),
  appUrl: z.string().url(),
  bootstrapMode: z.boolean(),
  sessionTtlHours: z.coerce.number().int().positive().default(12),
  stalwartUrl: z.string().url().optional(),
  // AI features (summarize / draft-with-AI) are software-level off by default:
  // aiEnabled defaults to false and any call must also have an aiApiKey, or the
  // domain layer fails fast with `ai_disabled` before attempting any network call.
  // Any additional network-level restriction (egress, firewalling) is a
  // deployment-specific concern outside this software's contract.
  aiEnabled: z.boolean().default(false),
  aiProvider: z.string().min(1).default("anthropic"),
  aiApiKey: z.string().min(1).optional(),
  aiModel: z.string().min(1).default("claude-opus-4-8"),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  env: Record<string, string | undefined>,
): AppConfig {
  return configSchema.parse({
    port: env.PORT ?? undefined,
    databaseUrl: env.DATABASE_URL,
    masterKey: env.MASTER_KEY,
    appUrl: env.APP_URL,
    bootstrapMode: env.BOOTSTRAP_MODE === "true" || env.BOOTSTRAP_MODE === "1",
    sessionTtlHours: env.SESSION_TTL_HOURS ?? undefined,
    stalwartUrl: env.STALWART_URL || undefined,
    aiEnabled: env.AI_ENABLED === "true" || env.AI_ENABLED === "1",
    aiProvider: env.AI_PROVIDER || undefined,
    aiApiKey: env.AI_API_KEY || undefined,
    aiModel: env.AI_MODEL || undefined,
  });
}
