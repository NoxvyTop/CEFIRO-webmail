import type { Db } from "../db/client";
import { log } from "../../core/logger";
import {
  aadFor,
  asKeyring,
  decryptWithKeyring,
  encryptWithKeyring,
  type Keyring,
} from "../../modules/credentials/crypto";

// GH #347: binds the client secret to "this is the SSO client secret", so it
// can never decrypt as if it were a different kind of stored secret (a mail
// credential, an oidc_state cookie) even under the same master key. Not
// per-instance: sso_config is a singleton row (id = 1), so there is no
// "owner" to key on the way mail-credentials.ts keys on user_id.
const SSO_CLIENT_SECRET_AAD = aadFor("sso");

export type SsoConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Login-button display name (#290); null/absent is treated as "SSO". */
  providerName?: string | null;
};

type SsoRow = {
  issuer: string;
  client_id: string;
  client_secret_ciphertext: Uint8Array;
  client_secret_iv: Uint8Array;
  key_version: number;
  scopes: string;
  provider_name: string | null;
};

export function createSsoConfigRepo(sql: Db, keys: CryptoKey | Keyring) {
  const keyring = asKeyring(keys);

  // Audit FIX 2: the public, unauthenticated GET /api/auth/mode calls
  // getProviderName() on every login-page load, so a per-request Postgres read
  // sat on a hot, unrate-limited path. Cache the value in this process:
  // `undefined` means "not loaded yet", and set() refreshes it so a config
  // change is reflected without a restart. Scope is this instance only — a
  // login-button name is bounded, cosmetic, and eventually consistent enough
  // that cross-instance staleness (until the next set() or restart) is fine.
  let providerNameCache: string | null | undefined;

  // Same progressive re-encryption contract as mail credentials: best-effort,
  // never fails the read, and skipped when a concurrent set() moved the row on.
  async function reEncrypt(clientSecret: string, fromVersion: number): Promise<void> {
    try {
      const { ciphertext, iv, keyVersion } = await encryptWithKeyring(
        keyring,
        clientSecret,
        SSO_CLIENT_SECRET_AAD,
      );
      await sql`
        update sso_config
        set client_secret_ciphertext = ${ciphertext}, client_secret_iv = ${iv},
            key_version = ${keyVersion}, updated_at = now()
        where id = 1 and key_version = ${fromVersion}
      `;
    } catch (error) {
      log("warn", "sso client secret re-encryption failed", {
        fromKeyVersion: fromVersion,
        toKeyVersion: keyring.current.version,
        error: String(error),
      });
    }
  }

  return {
    async exists(): Promise<boolean> {
      const rows = await sql<{ id: number }[]>`select id from sso_config where id = 1`;
      return rows.length > 0;
    },
    async get(): Promise<SsoConfig | null> {
      const rows = await sql<SsoRow[]>`
        select issuer, client_id, client_secret_ciphertext, client_secret_iv,
               key_version, scopes, provider_name
        from sso_config where id = 1
      `;
      const row = rows[0];
      if (!row) return null;
      const clientSecret = await decryptWithKeyring(
        keyring,
        {
          ciphertext: new Uint8Array(row.client_secret_ciphertext),
          iv: new Uint8Array(row.client_secret_iv),
          keyVersion: row.key_version,
        },
        SSO_CLIENT_SECRET_AAD,
      );
      if (row.key_version !== keyring.current.version) {
        await reEncrypt(clientSecret, row.key_version);
      }
      return {
        issuer: row.issuer,
        clientId: row.client_id,
        clientSecret,
        scopes: row.scopes,
        providerName: row.provider_name,
      };
    },
    // The login-button provider name only (#290). A dedicated lightweight read
    // for the UNAUTHENTICATED GET /api/auth/mode: unlike get() it decrypts
    // nothing, so it needs no master key and never touches the client secret.
    async getProviderName(): Promise<string | null> {
      // Served from the in-process cache when warm (audit FIX 2); only the first
      // read after boot — or after set() clears it — touches Postgres.
      if (providerNameCache !== undefined) return providerNameCache;
      const rows = await sql<{ provider_name: string | null }[]>`
        select provider_name from sso_config where id = 1
      `;
      providerNameCache = rows[0]?.provider_name ?? null;
      return providerNameCache;
    },
    async getPublic(): Promise<
      { issuer: string; clientId: string; scopes: string; providerName: string | null } | null
    > {
      const rows = await sql<
        { issuer: string; client_id: string; scopes: string; provider_name: string | null }[]
      >`
        select issuer, client_id, scopes, provider_name from sso_config where id = 1
      `;
      const row = rows[0];
      return row
        ? {
            issuer: row.issuer,
            clientId: row.client_id,
            scopes: row.scopes,
            providerName: row.provider_name,
          }
        : null;
    },
    async set(config: SsoConfig): Promise<void> {
      const { ciphertext, iv, keyVersion } = await encryptWithKeyring(
        keyring,
        config.clientSecret,
        SSO_CLIENT_SECRET_AAD,
      );
      await sql`
        insert into sso_config
          (id, issuer, client_id, client_secret_ciphertext, client_secret_iv, key_version, scopes, provider_name)
        values (1, ${config.issuer}, ${config.clientId}, ${ciphertext}, ${iv}, ${keyVersion}, ${config.scopes}, ${config.providerName ?? null})
        on conflict (id) do update set
          issuer = excluded.issuer,
          client_id = excluded.client_id,
          client_secret_ciphertext = excluded.client_secret_ciphertext,
          client_secret_iv = excluded.client_secret_iv,
          key_version = excluded.key_version,
          scopes = excluded.scopes,
          provider_name = excluded.provider_name,
          updated_at = now()
      `;
      // Refresh the cached login-button name so the public GET /api/auth/mode
      // reflects this change immediately (audit FIX 2), no restart needed.
      providerNameCache = config.providerName ?? null;
    },
  };
}

export type SsoConfigRepo = ReturnType<typeof createSsoConfigRepo>;
