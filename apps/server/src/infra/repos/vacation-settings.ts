import type { VacationSettings, VacationSettingsInput } from "@webmail/shared";
import type { Db } from "../db/client";

type VacationRow = {
  enabled: boolean;
  subject: string;
  message: string;
  starts_at: string | null;
  ends_at: string | null;
  interval_days: number;
};

const DEFAULTS: VacationSettings = {
  enabled: false,
  subject: "",
  message: "",
  startsAt: null,
  endsAt: null,
  intervalDays: 7,
};

function toVacationSettings(row: VacationRow): VacationSettings {
  return {
    enabled: row.enabled,
    subject: row.subject,
    message: row.message,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    intervalDays: row.interval_days,
  };
}

export function createVacationSettingsRepo(sql: Db) {
  return {
    async get(userId: string): Promise<VacationSettings> {
      const rows = await sql<VacationRow[]>`
        select enabled, subject, message,
               starts_at::text as starts_at, ends_at::text as ends_at, interval_days
        from vacation_settings
        where user_id = ${userId}
      `;
      return rows[0] ? toVacationSettings(rows[0]) : { ...DEFAULTS };
    },

    async set(userId: string, input: VacationSettingsInput): Promise<VacationSettings> {
      const rows = await sql<VacationRow[]>`
        insert into vacation_settings
          (user_id, enabled, subject, message, starts_at, ends_at, interval_days)
        values
          (${userId}, ${input.enabled}, ${input.subject}, ${input.message},
           ${input.startsAt}, ${input.endsAt}, ${input.intervalDays})
        on conflict (user_id) do update set
          enabled = excluded.enabled,
          subject = excluded.subject,
          message = excluded.message,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          interval_days = excluded.interval_days,
          updated_at = now()
        returning enabled, subject, message,
                  starts_at::text as starts_at, ends_at::text as ends_at, interval_days
      `;
      return toVacationSettings(rows[0]!);
    },
  };
}

export type VacationSettingsRepo = ReturnType<typeof createVacationSettingsRepo>;
