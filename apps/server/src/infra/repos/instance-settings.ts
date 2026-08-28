import type { Db } from "../db/client";

export type InstanceSettings = { sentWithFooterEnabled: boolean };

type InstanceSettingsRow = { sent_with_footer_enabled: boolean };

export function createInstanceSettingsRepo(sql: Db) {
  // GH #347: GET /api/instance is public and unauthenticated, so every hit was
  // a per-request Postgres read. Cache the singleton row in this process, same
  // pattern as sso-config.ts's providerNameCache — `undefined` means "not
  // loaded yet", and set() clears it so a config change is reflected without a
  // restart. Scope is this instance only: a footer flag is bounded, cosmetic,
  // and eventually consistent enough that cross-instance staleness (until the
  // next set() or restart) is fine.
  let cache: InstanceSettings | undefined;

  return {
    async get(): Promise<InstanceSettings> {
      if (cache !== undefined) return cache;
      const rows = await sql<InstanceSettingsRow[]>`
        select sent_with_footer_enabled from instance_settings where id = 1
      `;
      const row = rows[0];
      cache = { sentWithFooterEnabled: row?.sent_with_footer_enabled ?? false };
      return cache;
    },
    async set(settings: InstanceSettings): Promise<void> {
      await sql`
        insert into instance_settings (id, sent_with_footer_enabled)
        values (1, ${settings.sentWithFooterEnabled})
        on conflict (id) do update set
          sent_with_footer_enabled = excluded.sent_with_footer_enabled,
          updated_at = now()
      `;
      // Invalidate so the next get() re-reads Postgres, mirroring what was
      // just written. sso-config.ts's providerNameCache instead sets the new
      // value directly since it already has it in hand from `config`; the
      // same shortcut works here too, but invalidating keeps this repo
      // agnostic to whatever set() actually persisted.
      cache = undefined;
    },
  };
}

export type InstanceSettingsRepo = ReturnType<typeof createInstanceSettingsRepo>;
