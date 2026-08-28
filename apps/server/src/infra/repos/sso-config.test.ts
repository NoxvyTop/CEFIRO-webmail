import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { importMasterKey } from "../../modules/credentials/crypto";
import { createSsoConfigRepo } from "./sso-config";

async function testKey() {
  return importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
}

const sql = createDb(testDatabaseUrl());

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("sso config repo", () => {
  it("upserts and reads back with decrypted secret", async () => {
    const key = await importMasterKey(
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    );
    const repo = createSsoConfigRepo(sql, key);
    await repo.set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "super-secret-1",
      scopes: "openid profile email",
    });
    expect((await repo.get())?.clientSecret).toBe("super-secret-1");

    await repo.set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "super-secret-2",
      scopes: "openid email",
    });
    const updated = await repo.get();
    expect(updated?.clientSecret).toBe("super-secret-2");
    expect(updated?.scopes).toBe("openid email");

    const [row] = await sql<{ client_secret_ciphertext: Uint8Array }[]>`
      select client_secret_ciphertext from sso_config where id = 1
    `;
    const rawText = new TextDecoder().decode(new Uint8Array(row!.client_secret_ciphertext));
    expect(rawText).not.toContain("super-secret-2");
  });

  // GH #347: the client secret is sealed with additionalData = "sso"
  // (crypto.ts aadFor), so it can no longer be decrypted as if it were a
  // different kind of secret (a mail credential, an oidc_state cookie) even
  // under the SAME master key.
  it("binds the client secret to the \"sso\" purpose", async () => {
    const key = await importMasterKey(
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    );
    const repo = createSsoConfigRepo(sql, key);
    await repo.set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "bound-secret",
      scopes: "openid profile email",
    });

    const [row] = await sql<
      { client_secret_ciphertext: Uint8Array; client_secret_iv: Uint8Array }[]
    >`select client_secret_ciphertext, client_secret_iv from sso_config where id = 1`;
    const { decryptSecret, aadFor } = await import("../../modules/credentials/crypto");
    expect(
      await decryptSecret(
        key,
        new Uint8Array(row!.client_secret_ciphertext),
        new Uint8Array(row!.client_secret_iv),
        aadFor("sso"),
      ),
    ).toBe("bound-secret");
    // A different purpose must not decrypt it, even under the same key.
    await expect(
      decryptSecret(
        key,
        new Uint8Array(row!.client_secret_ciphertext),
        new Uint8Array(row!.client_secret_iv),
        aadFor("mail:someone"),
      ),
    ).rejects.toThrow();
  });

  // Migration safety: every row in the database predates AAD. Backward
  // compatibility comes from crypto.ts's decryptSecret fallback, not from
  // anything sso-config.ts does specially.
  it("still reads a client secret sealed before AAD existed", async () => {
    const key = await importMasterKey(
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    );
    // Bypasses the repo's set() (which now always binds AAD = "sso") to write
    // exactly what every pre-#347 row looks like.
    const { encryptSecret } = await import("../../modules/credentials/crypto");
    const { ciphertext, iv } = await encryptSecret(key, "legacy-client-secret");
    await sql`
      insert into sso_config (id, issuer, client_id, client_secret_ciphertext, client_secret_iv, key_version, scopes)
      values (1, 'https://auth.noxvytop.com/application/o/webmail/', 'webmail', ${ciphertext}, ${iv}, 1, 'openid profile email')
      on conflict (id) do update set
        client_secret_ciphertext = excluded.client_secret_ciphertext,
        client_secret_iv = excluded.client_secret_iv,
        key_version = excluded.key_version
    `;

    const repo = createSsoConfigRepo(sql, key);
    expect((await repo.get())?.clientSecret).toBe("legacy-client-secret");
  });

  // #290: the optional login-button provider name round-trips through set/get.
  it("stores and reads back the provider name, defaulting to null when unset", async () => {
    const key = await importMasterKey(
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    );
    const repo = createSsoConfigRepo(sql, key);

    // Unset on write: get() reports null and getProviderName() agrees.
    await repo.set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "cs",
      scopes: "openid profile email",
    });
    expect((await repo.get())?.providerName).toBeNull();
    expect(await repo.getProviderName()).toBeNull();

    // Set on write: both reads return it.
    await repo.set({
      issuer: "https://auth.noxvytop.com/application/o/webmail/",
      clientId: "webmail",
      clientSecret: "cs",
      scopes: "openid profile email",
      providerName: "Authentik",
    });
    expect((await repo.get())?.providerName).toBe("Authentik");
    expect(await repo.getProviderName()).toBe("Authentik");
  });

  // Audit FIX 2: GET /api/auth/mode is public and unrate-limited, so
  // getProviderName() must not hit Postgres on every login-page load. A fake sql
  // counts the SELECTs to prove the second read is served from the in-process
  // cache and that set() refreshes it without a re-query.
  it("caches getProviderName in-process and refreshes it on set", async () => {
    const key = await testKey();
    let providerSelects = 0;
    const fakeSql = ((strings: TemplateStringsArray) => {
      if (strings.join(" ").includes("select provider_name")) {
        providerSelects += 1;
        return Promise.resolve([{ provider_name: "Authentik" }]);
      }
      // The set() upsert (and anything else) resolves to an empty result.
      return Promise.resolve([]);
    }) as unknown as Db;
    const repo = createSsoConfigRepo(fakeSql, key);

    expect(await repo.getProviderName()).toBe("Authentik");
    expect(await repo.getProviderName()).toBe("Authentik");
    expect(providerSelects).toBe(1); // second read served from cache

    await repo.set({
      issuer: "https://auth.test",
      clientId: "webmail",
      clientSecret: "cs",
      scopes: "openid email",
      providerName: "Okta",
    });
    // set() refreshed the cached value, so the read below returns it...
    expect(await repo.getProviderName()).toBe("Okta");
    // ...and still without touching Postgres again.
    expect(providerSelects).toBe(1);
  });
});
