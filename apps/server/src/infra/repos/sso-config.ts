import type { Db } from "../db/client";
import { decryptSecret, encryptSecret } from "../../modules/credentials/crypto";

export type SsoConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
};

type SsoRow = {
  issuer: string;
  client_id: string;
  client_secret_ciphertext: Uint8Array;
  client_secret_iv: Uint8Array;
  scopes: string;
};

export function createSsoConfigRepo(sql: Db, key: CryptoKey) {
  return {
    async exists(): Promise<boolean> {
      const rows = await sql<{ id: number }[]>`select id from sso_config where id = 1`;
      return rows.length > 0;
    },
    async get(): Promise<SsoConfig | null> {
      const rows = await sql<SsoRow[]>`
        select issuer, client_id, client_secret_ciphertext, client_secret_iv, scopes
        from sso_config where id = 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        issuer: row.issuer,
        clientId: row.client_id,
        clientSecret: await decryptSecret(
          key,
          new Uint8Array(row.client_secret_ciphertext),
          new Uint8Array(row.client_secret_iv),
        ),
        scopes: row.scopes,
      };
    },
    async getPublic(): Promise<{ issuer: string; clientId: string; scopes: string } | null> {
      const rows = await sql<{ issuer: string; client_id: string; scopes: string }[]>`
        select issuer, client_id, scopes from sso_config where id = 1
      `;
      const row = rows[0];
      return row ? { issuer: row.issuer, clientId: row.client_id, scopes: row.scopes } : null;
    },
    async set(config: SsoConfig): Promise<void> {
      const { ciphertext, iv } = await encryptSecret(key, config.clientSecret);
      await sql`
        insert into sso_config
          (id, issuer, client_id, client_secret_ciphertext, client_secret_iv, key_version, scopes)
        values (1, ${config.issuer}, ${config.clientId}, ${ciphertext}, ${iv}, 1, ${config.scopes})
        on conflict (id) do update set
          issuer = excluded.issuer,
          client_id = excluded.client_id,
          client_secret_ciphertext = excluded.client_secret_ciphertext,
          client_secret_iv = excluded.client_secret_iv,
          key_version = excluded.key_version,
          scopes = excluded.scopes,
          updated_at = now()
      `;
    },
  };
}

export type SsoConfigRepo = ReturnType<typeof createSsoConfigRepo>;
