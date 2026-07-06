import type postgres from "postgres";
import type { Db } from "../db/client";

export type AuditEntry = {
  actor: string;
  action: string;
  target?: string;
  ip?: string;
  detail?: Record<string, unknown>;
};

export function createAuditRepo(sql: Db) {
  return {
    async record(entry: AuditEntry): Promise<void> {
      await sql`
        insert into audit_log (actor, action, target, ip, detail)
        values (
          ${entry.actor}, ${entry.action}, ${entry.target ?? null},
          ${entry.ip ?? null}, ${sql.json((entry.detail ?? {}) as postgres.JSONValue)}
        )
      `;
    },
  };
}

export type AuditRepo = ReturnType<typeof createAuditRepo>;
