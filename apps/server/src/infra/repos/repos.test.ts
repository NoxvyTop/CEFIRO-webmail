import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { migrate } from "../db/migrate";
import { importMasterKey } from "../../modules/credentials/crypto";
import { createUsersRepo } from "./users";
import { createMailCredentialsRepo } from "./mail-credentials";
import { createAuditRepo } from "./audit";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

function keyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("users repo", () => {
  it("creates and finds a user by email", async () => {
    const users = createUsersRepo(sql);
    const email = `u-${crypto.randomUUID()}@noxvytop.com`;
    const created = await users.create({ email, displayName: "Test User" });
    expect(created.role).toBe("employee");
    expect(created.locale).toBe("es");
    const found = await users.findByEmail(email);
    expect(found?.id).toBe(created.id);
    expect(await users.findByEmail("nobody@noxvytop.com")).toBeNull();
  });

  it("finds users case-insensitively and stores emails lowercased", async () => {
    const users = createUsersRepo(sql);
    const local = `case-${crypto.randomUUID()}`;
    const created = await users.create({
      email: `${local.toUpperCase()}@NoxvyTop.com`,
      displayName: "Case User",
    });
    expect(created.email).toBe(`${local.toUpperCase()}@noxvytop.com`.toLowerCase());
    const found = await users.findByEmail(`${local.toUpperCase()}@NOXVYTOP.COM`);
    expect(found?.id).toBe(created.id);
  });
});

describe("mail credentials repo", () => {
  it("round-trips a credential and stores it encrypted at rest", async () => {
    const users = createUsersRepo(sql);
    const key = await importMasterKey(keyB64());
    const creds = createMailCredentialsRepo(sql, key);
    const user = await users.create({
      email: `c-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Cred User",
    });
    await creds.set(user.id, "mailbox-secret-1");
    expect(await creds.get(user.id)).toBe("mailbox-secret-1");

    const [row] = await sql<{ ciphertext: Uint8Array }[]>`
      select ciphertext from mail_credentials where user_id = ${user.id}
    `;
    const rawText = new TextDecoder().decode(new Uint8Array(row!.ciphertext));
    expect(rawText).not.toContain("mailbox-secret-1");

    await creds.set(user.id, "mailbox-secret-2");
    expect(await creds.get(user.id)).toBe("mailbox-secret-2");
  });

  it("returns null for a user without credential", async () => {
    const key = await importMasterKey(keyB64());
    const creds = createMailCredentialsRepo(sql, key);
    expect(await creds.get(crypto.randomUUID())).toBeNull();
  });

  it("exists() reports presence without decrypting", async () => {
    const users = createUsersRepo(sql);
    const key = await importMasterKey(keyB64());
    const creds = createMailCredentialsRepo(sql, key);
    const user = await users.create({
      email: `e-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Exists User",
    });
    expect(await creds.exists(user.id)).toBe(false);
    await creds.set(user.id, "mailbox-secret-exists");

    // A key mismatch would make get() throw on decrypt, but exists() only
    // checks row presence, so it must still report true.
    const wrongKey = await importMasterKey(keyB64());
    const credsWithWrongKey = createMailCredentialsRepo(sql, wrongKey);
    expect(await credsWithWrongKey.exists(user.id)).toBe(true);
    await expect(credsWithWrongKey.get(user.id)).rejects.toThrow();

    expect(await creds.exists(user.id)).toBe(true);
  });
});

describe("audit repo", () => {
  it("records an entry", async () => {
    const audit = createAuditRepo(sql);
    const actor = `actor-${crypto.randomUUID()}`;
    await audit.record({ actor, action: "test.action", detail: { a: 1 } });
    const rows = await sql`select action from audit_log where actor = ${actor}`;
    expect(rows.length).toBe(1);
  });
});
