import type postgres from "postgres";
import type { Db } from "../db/client";

const DEFAULTS = { groupMailInMainInbox: true };

export function createUserPreferencesRepo(sql: Db) {
  return {
    async get(userId: string): Promise<{ groupMailInMainInbox: boolean }> {
      const rows = await sql<{ preferences: Record<string, unknown> }[]>`
        select preferences from user_preferences where user_id = ${userId}
      `;
      const stored = rows[0]?.preferences ?? {};
      return {
        groupMailInMainInbox:
          typeof stored.groupMailInMainInbox === "boolean"
            ? stored.groupMailInMainInbox
            : DEFAULTS.groupMailInMainInbox,
      };
    },
    async merge(
      userId: string,
      patch: Record<string, unknown>,
    ): Promise<{ groupMailInMainInbox: boolean }> {
      await sql`
        insert into user_preferences (user_id, preferences)
        values (${userId}, ${sql.json(patch as postgres.JSONValue)})
        on conflict (user_id) do update set
          preferences = user_preferences.preferences || excluded.preferences
      `;
      return this.get(userId);
    },
  };
}

export type UserPreferencesRepo = ReturnType<typeof createUserPreferencesRepo>;
