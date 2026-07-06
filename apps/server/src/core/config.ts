import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  databaseUrl: z.string().min(1),
  masterKey: z.string().length(44),
  appUrl: z.string().url(),
  bootstrapMode: z.boolean(),
  sessionTtlHours: z.coerce.number().int().positive().default(12),
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
  });
}
