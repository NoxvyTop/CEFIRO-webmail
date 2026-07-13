import type { Db } from "../db/client";
import { decryptSecret, encryptSecret } from "../../modules/credentials/crypto";

export function createMailCredentialsRepo(sql: Db, key: CryptoKey) {
  return {
    async set(userId: string, password: string): Promise<void> {
      const { ciphertext, iv } = await encryptSecret(key, password);
      await sql`
        insert into mail_credentials (user_id, ciphertext, iv, key_version)
        values (${userId}, ${ciphertext}, ${iv}, 1)
        on conflict (user_id) do update set
          ciphertext = excluded.ciphertext,
          iv = excluded.iv,
          key_version = excluded.key_version,
          updated_at = now()
      `;
    },
    async get(userId: string): Promise<string | null> {
      const rows = await sql<{ ciphertext: Uint8Array; iv: Uint8Array }[]>`
        select ciphertext, iv from mail_credentials where user_id = ${userId}
      `;
      const row = rows[0];
      if (!row) return null;
      return decryptSecret(key, new Uint8Array(row.ciphertext), new Uint8Array(row.iv));
    },
    async exists(userId: string): Promise<boolean> {
      const rows = await sql`select 1 from mail_credentials where user_id = ${userId}`;
      return rows.length > 0;
    },
  };
}

export type MailCredentialsRepo = ReturnType<typeof createMailCredentialsRepo>;
