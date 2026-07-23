import type { Db } from "../db/client";

export type InstanceSettings = { sentWithFooterEnabled: boolean };

type InstanceSettingsRow = { sent_with_footer_enabled: boolean };

export function createInstanceSettingsRepo(sql: Db) {
  return {
    async get(): Promise<InstanceSettings> {
      const rows = await sql<InstanceSettingsRow[]>`
        select sent_with_footer_enabled from instance_settings where id = 1
      `;
      const row = rows[0];
      return { sentWithFooterEnabled: row?.sent_with_footer_enabled ?? false };
    },
    async set(settings: InstanceSettings): Promise<void> {
      await sql`
        insert into instance_settings (id, sent_with_footer_enabled)
        values (1, ${settings.sentWithFooterEnabled})
        on conflict (id) do update set
          sent_with_footer_enabled = excluded.sent_with_footer_enabled,
          updated_at = now()
      `;
    },
  };
}

export type InstanceSettingsRepo = ReturnType<typeof createInstanceSettingsRepo>;
