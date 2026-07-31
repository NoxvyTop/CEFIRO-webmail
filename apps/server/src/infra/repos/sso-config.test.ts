import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { importMasterKey } from "../../modules/credentials/crypto";
import { createSsoConfigRepo } from "./sso-config";

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
});
