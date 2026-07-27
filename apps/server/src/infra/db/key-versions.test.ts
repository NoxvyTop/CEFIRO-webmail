import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "./client";
import { migrate } from "./migrate";
import { findUncoveredKeyVersions } from "./key-versions";
import { createKeyring, importMasterKey } from "../../modules/credentials/crypto";
import { createSsoConfigRepo } from "../repos/sso-config";
import { createMailCredentialsRepo } from "../repos/mail-credentials";
import { createUsersRepo } from "../repos/users";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

// Versions no other test uses, so assertions stay independent of leftover rows.
const ORPHAN_MAIL_VERSION = 4242;
const ORPHAN_SSO_VERSION = 4243;
const ORPHAN_INTEGRATION_VERSION = 4244;

async function keyring(version: number) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return createKeyring({
    version,
    key: await importMasterKey(btoa(String.fromCharCode(...raw))),
  });
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});

afterAll(async () => {
  await sql`delete from integrations where kind = 'key-version-probe'`;
  await createSsoConfigRepo(sql, await keyring(1)).set({
    issuer: "https://auth.noxvytop.com/application/o/webmail/",
    clientId: "webmail",
    clientSecret: "reset-after-key-version-probe",
    scopes: "openid profile email",
  });
  await sql.end();
});

describe("findUncoveredKeyVersions", () => {
  it("reports a mail credential the keyring cannot decrypt", async () => {
    const user = await createUsersRepo(sql).create({
      email: `kv-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Key Version User",
    });
    await createMailCredentialsRepo(sql, await keyring(ORPHAN_MAIL_VERSION)).set(
      user.id,
      "orphaned",
    );

    const uncovered = await findUncoveredKeyVersions(sql, await keyring(1));

    expect(uncovered).toContainEqual(
      expect.objectContaining({
        table: "mail_credentials",
        keyVersion: ORPHAN_MAIL_VERSION,
      }),
    );
  });

  it("stays silent about a version the keyring holds as a retired key", async () => {
    const current = await keyring(1);
    const withRetiredKey = createKeyring(
      current.current,
      new Map([[ORPHAN_MAIL_VERSION, current.current.key]]),
    );

    const uncovered = await findUncoveredKeyVersions(sql, withRetiredKey);

    expect(uncovered.map((entry) => entry.keyVersion)).not.toContain(ORPHAN_MAIL_VERSION);
  });

  it("reports the sso client secret the keyring cannot decrypt", async () => {
    await createSsoConfigRepo(sql, await keyring(ORPHAN_SSO_VERSION)).set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "orphaned-client-secret",
      scopes: "openid profile email",
    });

    const uncovered = await findUncoveredKeyVersions(sql, await keyring(1));

    expect(uncovered).toContainEqual(
      expect.objectContaining({ table: "sso_config", keyVersion: ORPHAN_SSO_VERSION }),
    );
  });

  it("reports integration secrets the keyring cannot decrypt", async () => {
    await sql`
      insert into integrations (kind, secrets_ciphertext, secrets_iv, key_version)
      values ('key-version-probe', '\\x00'::bytea, '\\x00'::bytea, ${ORPHAN_INTEGRATION_VERSION})
    `;

    const uncovered = await findUncoveredKeyVersions(sql, await keyring(1));

    expect(uncovered).toContainEqual(
      expect.objectContaining({
        table: "integrations",
        keyVersion: ORPHAN_INTEGRATION_VERSION,
      }),
    );
  });

  it("ignores integration rows that store no encrypted secrets", async () => {
    await sql`delete from integrations where kind = 'key-version-probe'`;
    await sql`
      insert into integrations (kind, key_version)
      values ('key-version-probe', ${ORPHAN_INTEGRATION_VERSION})
    `;

    const uncovered = await findUncoveredKeyVersions(sql, await keyring(1));

    expect(uncovered.map((entry) => entry.keyVersion)).not.toContain(
      ORPHAN_INTEGRATION_VERSION,
    );
  });

  it("counts the rows blocked by each missing version", async () => {
    const uncovered = await findUncoveredKeyVersions(sql, await keyring(1));
    const mail = uncovered.find(
      (entry) =>
        entry.table === "mail_credentials" && entry.keyVersion === ORPHAN_MAIL_VERSION,
    );
    expect(mail?.rows).toBeGreaterThan(0);
  });
});
