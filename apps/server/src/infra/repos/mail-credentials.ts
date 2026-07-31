import type { Db } from "../db/client";
import { log } from "../../core/logger";
import {
  asKeyring,
  decryptWithKeyring,
  encryptWithKeyring,
  type Keyring,
} from "../../modules/credentials/crypto";

export function createMailCredentialsRepo(sql: Db, keys: CryptoKey | Keyring) {
  const keyring = asKeyring(keys);

  // Progressive re-encryption: a row read under a retired key is re-sealed
  // under the current one, so rotation completes as users use their mail.
  // Best-effort on purpose — the read already succeeded and the caller needs
  // that password to reach their mailbox, so a failed write-back is logged and
  // swallowed. The `key_version` guard skips the update when a concurrent
  // set() already replaced the row.
  async function reEncrypt(
    userId: string,
    password: string,
    fromVersion: number,
  ): Promise<void> {
    try {
      const { ciphertext, iv, keyVersion } = await encryptWithKeyring(keyring, password);
      await sql`
        update mail_credentials
        set ciphertext = ${ciphertext}, iv = ${iv}, key_version = ${keyVersion},
            updated_at = now()
        where user_id = ${userId} and key_version = ${fromVersion}
      `;
    } catch (error) {
      log("warn", "mail credential re-encryption failed", {
        userId,
        fromKeyVersion: fromVersion,
        toKeyVersion: keyring.current.version,
        error: String(error),
      });
    }
  }

  return {
    async set(userId: string, password: string): Promise<void> {
      const { ciphertext, iv, keyVersion } = await encryptWithKeyring(keyring, password);
      await sql`
        insert into mail_credentials (user_id, ciphertext, iv, key_version)
        values (${userId}, ${ciphertext}, ${iv}, ${keyVersion})
        on conflict (user_id) do update set
          ciphertext = excluded.ciphertext,
          iv = excluded.iv,
          key_version = excluded.key_version,
          updated_at = now()
      `;
    },
    async get(userId: string): Promise<string | null> {
      const rows = await sql<
        { ciphertext: Uint8Array; iv: Uint8Array; key_version: number }[]
      >`
        select ciphertext, iv, key_version from mail_credentials where user_id = ${userId}
      `;
      const row = rows[0];
      if (!row) return null;
      const password = await decryptWithKeyring(keyring, {
        ciphertext: new Uint8Array(row.ciphertext),
        iv: new Uint8Array(row.iv),
        keyVersion: row.key_version,
      });
      if (row.key_version !== keyring.current.version) {
        await reEncrypt(userId, password, row.key_version);
      }
      return password;
    },
    async exists(userId: string): Promise<boolean> {
      const rows = await sql`select 1 from mail_credentials where user_id = ${userId}`;
      return rows.length > 0;
    },
    // Batched counterpart of exists() (GH #153): resolves mailbox-linked state
    // for a whole page of users in ONE query, replacing the per-user N+1 the
    // admin list used to issue. Returns the subset of ids that have a
    // credential, as a Set for O(1) membership checks by the caller.
    async existsForUsers(userIds: string[]): Promise<Set<string>> {
      if (userIds.length === 0) return new Set();
      const rows = await sql<{ user_id: string }[]>`
        select user_id from mail_credentials where user_id = any(${userIds}::uuid[])
      `;
      return new Set(rows.map((row) => row.user_id));
    },
    // Total number of mailbox-linked users, for the Resumen dashboard's gauge.
    // user_id is the primary key (one row per user, ON DELETE CASCADE), so a
    // plain COUNT can never over-count or include orphans.
    async count(): Promise<number> {
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from mail_credentials
      `;
      return Number(rows[0]!.count);
    },
  };
}

export type MailCredentialsRepo = ReturnType<typeof createMailCredentialsRepo>;
