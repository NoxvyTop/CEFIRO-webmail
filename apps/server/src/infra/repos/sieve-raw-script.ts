import type { SieveRawScript } from "@webmail/shared";
import type { Db } from "../db/client";

type SieveRawScriptRow = {
  mode: SieveRawScript["mode"];
  script: string;
  // postgres.js maps timestamptz to a Date; the API carries an ISO string so
  // the value a client parses never depends on the server's locale.
  updated_at: Date;
};

/**
 * A user who never opened the advanced editor is in rule-builder mode with
 * nothing hand-written to keep — the same answer the row's own defaults give.
 */
const NEVER_WRITTEN: SieveRawScript = { mode: "rules", script: "", updatedAt: null };

function toSieveRawScript(row: SieveRawScriptRow): SieveRawScript {
  return { mode: row.mode, script: row.script, updatedAt: row.updated_at.toISOString() };
}

/**
 * The hand-written Sieve script of one account, and which author owns the
 * script this server pushes (GH #23).
 *
 * The two writes below are deliberately asymmetric, and that asymmetry IS the
 * feature: `save` takes ownership and replaces the text, while `handBackToRules`
 * only flips the mode and leaves `script` exactly as it was. There is no
 * operation here that deletes a hand-written script, so no sequence of mode
 * switches can lose one.
 */
export function createSieveRawScriptRepo(sql: Db) {
  return {
    async get(userId: string): Promise<SieveRawScript> {
      const rows = await sql<SieveRawScriptRow[]>`
        select mode, script, updated_at
        from sieve_raw_script
        where user_id = ${userId}
      `;
      return rows[0] ? toSieveRawScript(rows[0]) : { ...NEVER_WRITTEN };
    },

    /**
     * Stores the script and makes it the one that runs. Saving a hand-written
     * script IS the statement that it owns the account — there is no separate
     * "activate" step to forget, and therefore no state where a user has saved
     * a script that silently does nothing.
     */
    async save(userId: string, script: string): Promise<SieveRawScript> {
      const rows = await sql<SieveRawScriptRow[]>`
        insert into sieve_raw_script (user_id, mode, script)
        values (${userId}, 'raw', ${script})
        on conflict (user_id) do update set
          mode = 'raw',
          script = excluded.script,
          updated_at = now()
        returning mode, script, updated_at
      `;
      return toSieveRawScript(rows[0]!);
    },

    /**
     * Gives the script back to the rule builder. `script` is untouched on
     * purpose: the user is deactivating their script, not discarding it, and
     * they must find it unchanged when they come back.
     */
    async handBackToRules(userId: string): Promise<SieveRawScript> {
      const rows = await sql<SieveRawScriptRow[]>`
        insert into sieve_raw_script (user_id, mode, script)
        values (${userId}, 'rules', '')
        on conflict (user_id) do update set
          mode = 'rules',
          updated_at = now()
        returning mode, script, updated_at
      `;
      return toSieveRawScript(rows[0]!);
    },
  };
}

export type SieveRawScriptRepo = ReturnType<typeof createSieveRawScriptRepo>;
