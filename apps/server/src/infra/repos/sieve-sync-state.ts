import type { SieveSyncState } from "@webmail/shared";
import type { Db } from "../db/client";

type SieveSyncStateRow = {
  status: SieveSyncState["status"];
  attempts: number;
  last_error: string | null;
  // postgres.js maps timestamptz to a Date; the API carries an ISO string so
  // the value a client parses never depends on the server's locale.
  updated_at: Date;
};

/**
 * A user who never saved a filter has nothing that could be out of sync, so the
 * absence of a row reads as synced rather than as an unknown state the UI would
 * have to warn about.
 */
const NEVER_WRITTEN: SieveSyncState = {
  status: "synced",
  attempts: 0,
  lastError: null,
  updatedAt: null,
};

function toSieveSyncState(row: SieveSyncStateRow): SieveSyncState {
  return {
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Tracks whether the Sieve script Stalwart enforces still matches what this
 * database holds (GH #221).
 *
 * The write to `filter_rules` / `vacation_settings` and the push to Stalwart
 * cannot be one transaction — the second is an HTTP call to another service —
 * so instead of pretending they are, the mismatch is recorded: mark pending
 * before the local write, mark synced only once the push actually landed.
 * Whatever is left as pending or failed is a rule that is saved and NOT being
 * applied, which is exactly what the user needs told and what a later attempt
 * has to reconcile.
 */
export function createSieveSyncStateRepo(sql: Db) {
  /**
   * `attempts` counts CONSECUTIVE failed pushes, so it is incremented by a
   * failure, cleared by a success, and left alone by a local change that has
   * not been attempted yet — a burst of edits during an outage must not reset
   * the count that says how long this has been broken.
   */
  async function upsert(
    userId: string,
    status: SieveSyncState["status"],
    lastError: string | null,
    attempts: "reset" | "increment" | "keep",
  ): Promise<SieveSyncState> {
    const rows = await sql<SieveSyncStateRow[]>`
      insert into sieve_sync_state (user_id, status, attempts, last_error)
      values (${userId}, ${status}, ${attempts === "increment" ? 1 : 0}, ${lastError})
      on conflict (user_id) do update set
        status = excluded.status,
        attempts = case ${attempts}::text
          when 'increment' then sieve_sync_state.attempts + 1
          when 'keep' then sieve_sync_state.attempts
          else 0
        end,
        last_error = excluded.last_error,
        updated_at = now()
      returning status, attempts, last_error, updated_at
    `;
    return toSieveSyncState(rows[0]!);
  }

  return {
    async get(userId: string): Promise<SieveSyncState> {
      const rows = await sql<SieveSyncStateRow[]>`
        select status, attempts, last_error, updated_at
        from sieve_sync_state
        where user_id = ${userId}
      `;
      return rows[0] ? toSieveSyncState(rows[0]) : { ...NEVER_WRITTEN };
    },

    /**
     * "There is a local change Stalwart has not been told about yet." Written
     * BEFORE the local write, so a process that dies mid-flight leaves a state
     * that overstates the problem (a reconcile pushes an already-correct script
     * and settles back to synced) instead of one that hides it.
     */
    markPending(userId: string): Promise<SieveSyncState> {
      return upsert(userId, "pending", null, "keep");
    },

    markSynced(userId: string): Promise<SieveSyncState> {
      return upsert(userId, "synced", null, "reset");
    },

    markFailed(userId: string, code: string): Promise<SieveSyncState> {
      return upsert(userId, "failed", code, "increment");
    },
  };
}

export type SieveSyncStateRepo = ReturnType<typeof createSieveSyncStateRepo>;
