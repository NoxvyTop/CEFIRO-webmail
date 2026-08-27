import type { Db } from "./client";
import { knownKeyVersions, type Keyring } from "../../modules/credentials/crypto";

/** A `key_version` present in the database that the keyring has no key for. */
export type UncoveredKeyVersion = {
  table: string;
  keyVersion: number;
  rows: number;
};

type VersionCount = { key_version: number; rows: number };

function uncovered(
  table: string,
  counts: readonly VersionCount[],
  covered: ReadonlySet<number>,
): UncoveredKeyVersion[] {
  return counts
    .filter((count) => !covered.has(count.key_version))
    .map((count) => ({ table, keyVersion: count.key_version, rows: count.rows }));
}

/**
 * Lists every stored `key_version` the keyring cannot decrypt, so a rotation
 * that would leave rows unreadable fails at boot instead of failing per user,
 * at runtime, the first time each one reaches for their mail.
 */
export async function findUncoveredKeyVersions(
  sql: Db,
  keyring: Keyring,
): Promise<UncoveredKeyVersion[]> {
  const covered = new Set(knownKeyVersions(keyring));
  const [mailCredentials, ssoConfig, integrations] = await Promise.all([
    sql<VersionCount[]>`
      select key_version, count(*)::int as rows from mail_credentials group by key_version
    `,
    sql<VersionCount[]>`
      select key_version, count(*)::int as rows from sso_config group by key_version
    `,
    // `integrations` only stamps a key_version when it actually stores an
    // encrypted secret; rows without a ciphertext have nothing to decrypt.
    sql<VersionCount[]>`
      select key_version, count(*)::int as rows from integrations
      where secrets_ciphertext is not null and key_version is not null
      group by key_version
    `,
  ]);
  return [
    ...uncovered("mail_credentials", mailCredentials, covered),
    ...uncovered("sso_config", ssoConfig, covered),
    ...uncovered("integrations", integrations, covered),
  ].sort((a, b) => a.table.localeCompare(b.table) || a.keyVersion - b.keyVersion);
}
