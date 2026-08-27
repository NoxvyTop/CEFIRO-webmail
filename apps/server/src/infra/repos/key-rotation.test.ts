import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createKeyring, importMasterKey } from "../../modules/credentials/crypto";
import { createMailCredentialsRepo } from "./mail-credentials";
import { createSsoConfigRepo } from "./sso-config";
import { createUsersRepo } from "./users";

const sql = createDb(testDatabaseUrl());

function keyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

/**
 * Lets the first query of an operation through and rejects every later one, so
 * the read succeeds while the progressive re-encryption write-back fails.
 */
function dbFailingAfterFirstQuery(base: Db): Db {
  let queries = 0;
  return new Proxy(base, {
    apply(target, thisArg, args) {
      queries += 1;
      if (queries > 1) return Promise.reject(new Error("write-back unavailable"));
      return Reflect.apply(
        target as unknown as (...a: unknown[]) => unknown,
        thisArg,
        args,
      );
    },
  });
}

// Every user this suite creates, so afterAll can remove the mail_credentials
// rows it seeded (GH #181): they carry test key versions (2, 4, 9, 4242) that,
// left behind in a shared database, make the boot-time key-ring guard refuse to
// start the server. Deleting the users cascades to mail_credentials
// (migrations/0001_initial.sql: `on delete cascade`).
const createdUserIds: string[] = [];

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await sql`delete from users where id = any(${createdUserIds}::uuid[])`;
  }
  await sql.end();
});

async function createUser(): Promise<string> {
  const user = await createUsersRepo(sql).create({
    email: `rot-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Rotation User",
  });
  createdUserIds.push(user.id);
  return user.id;
}

describe("mail credentials repo under master key rotation", () => {
  it("stamps the current key version instead of a hardcoded 1", async () => {
    const userId = await createUser();
    const keyring = createKeyring({ version: 4, key: await importMasterKey(keyB64()) });

    await createMailCredentialsRepo(sql, keyring).set(userId, "stamped");

    const [row] = await sql<{ key_version: number }[]>`
      select key_version from mail_credentials where user_id = ${userId}
    `;
    expect(row?.key_version).toBe(4);
  });

  it("still reads a credential written before the key was rotated", async () => {
    const userId = await createUser();
    const retiredKey = await importMasterKey(keyB64());
    const currentKey = await importMasterKey(keyB64());

    await createMailCredentialsRepo(
      sql,
      createKeyring({ version: 1, key: retiredKey }),
    ).set(userId, "pre-rotation-secret");

    const afterRotation = createMailCredentialsRepo(
      sql,
      createKeyring({ version: 2, key: currentKey }, new Map([[1, retiredKey]])),
    );
    expect(await afterRotation.get(userId)).toBe("pre-rotation-secret");
  });

  it("re-encrypts the row it read under a retired key", async () => {
    const userId = await createUser();
    const retiredKey = await importMasterKey(keyB64());
    const currentKey = await importMasterKey(keyB64());

    await createMailCredentialsRepo(
      sql,
      createKeyring({ version: 1, key: retiredKey }),
    ).set(userId, "migrate-me");
    await createMailCredentialsRepo(
      sql,
      createKeyring({ version: 2, key: currentKey }, new Map([[1, retiredKey]])),
    ).get(userId);

    // The retired key is now gone from the keyring; the row must still read,
    // which is only possible if the write-back re-sealed it under version 2.
    const withoutRetiredKey = createMailCredentialsRepo(
      sql,
      createKeyring({ version: 2, key: currentKey }),
    );
    expect(await withoutRetiredKey.get(userId)).toBe("migrate-me");
  });

  it("leaves a row alone when it already carries the current version", async () => {
    const userId = await createUser();
    const keyring = createKeyring({ version: 2, key: await importMasterKey(keyB64()) });
    const repo = createMailCredentialsRepo(sql, keyring);
    await repo.set(userId, "already-current");

    const [before] = await sql<{ updated_at: Date }[]>`
      select updated_at from mail_credentials where user_id = ${userId}
    `;
    expect(await repo.get(userId)).toBe("already-current");
    const [after] = await sql<{ updated_at: Date }[]>`
      select updated_at from mail_credentials where user_id = ${userId}
    `;

    expect(after?.updated_at).toEqual(before?.updated_at);
  });

  it("names the missing key version when the keyring cannot cover the row", async () => {
    const userId = await createUser();
    await createMailCredentialsRepo(
      sql,
      createKeyring({ version: 9, key: await importMasterKey(keyB64()) }),
    ).set(userId, "unreachable");

    const otherKeyring = createKeyring({
      version: 1,
      key: await importMasterKey(keyB64()),
    });
    await expect(
      createMailCredentialsRepo(sql, otherKeyring).get(userId),
    ).rejects.toThrow(/9/);
  });

  it("returns the credential even when the re-encryption write-back fails", async () => {
    const userId = await createUser();
    const retiredKey = await importMasterKey(keyB64());
    const currentKey = await importMasterKey(keyB64());
    await createMailCredentialsRepo(
      sql,
      createKeyring({ version: 1, key: retiredKey }),
    ).set(userId, "read-must-survive");

    const repo = createMailCredentialsRepo(
      dbFailingAfterFirstQuery(sql),
      createKeyring({ version: 2, key: currentKey }, new Map([[1, retiredKey]])),
    );

    expect(await repo.get(userId)).toBe("read-must-survive");
  });
});

describe("sso config repo under master key rotation", () => {
  it("stamps the current key version instead of a hardcoded 1", async () => {
    const keyring = createKeyring({ version: 5, key: await importMasterKey(keyB64()) });
    await createSsoConfigRepo(sql, keyring).set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "stamped-secret",
      scopes: "openid profile email",
    });

    const [row] = await sql<{ key_version: number }[]>`
      select key_version from sso_config where id = 1
    `;
    expect(row?.key_version).toBe(5);
  });

  it("still reads the client secret written before the key was rotated", async () => {
    const retiredKey = await importMasterKey(keyB64());
    const currentKey = await importMasterKey(keyB64());
    await createSsoConfigRepo(sql, createKeyring({ version: 1, key: retiredKey })).set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "pre-rotation-client-secret",
      scopes: "openid profile email",
    });

    const afterRotation = createSsoConfigRepo(
      sql,
      createKeyring({ version: 2, key: currentKey }, new Map([[1, retiredKey]])),
    );
    expect((await afterRotation.get())?.clientSecret).toBe("pre-rotation-client-secret");
  });

  it("re-encrypts the client secret it read under a retired key", async () => {
    const retiredKey = await importMasterKey(keyB64());
    const currentKey = await importMasterKey(keyB64());
    await createSsoConfigRepo(sql, createKeyring({ version: 1, key: retiredKey })).set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "migrate-this-secret",
      scopes: "openid profile email",
    });
    await createSsoConfigRepo(
      sql,
      createKeyring({ version: 2, key: currentKey }, new Map([[1, retiredKey]])),
    ).get();

    const withoutRetiredKey = createSsoConfigRepo(
      sql,
      createKeyring({ version: 2, key: currentKey }),
    );
    expect((await withoutRetiredKey.get())?.clientSecret).toBe("migrate-this-secret");
  });

  it("returns the client secret even when the re-encryption write-back fails", async () => {
    const retiredKey = await importMasterKey(keyB64());
    const currentKey = await importMasterKey(keyB64());
    await createSsoConfigRepo(sql, createKeyring({ version: 1, key: retiredKey })).set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "sso-read-must-survive",
      scopes: "openid profile email",
    });

    const repo = createSsoConfigRepo(
      dbFailingAfterFirstQuery(sql),
      createKeyring({ version: 2, key: currentKey }, new Map([[1, retiredKey]])),
    );

    expect((await repo.get())?.clientSecret).toBe("sso-read-must-survive");
  });
});
