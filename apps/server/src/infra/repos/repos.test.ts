import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { importMasterKey } from "../../modules/credentials/crypto";
import { createUsersRepo } from "./users";
import { createMailCredentialsRepo } from "./mail-credentials";
import { createAuditRepo } from "./audit";

const sql = createDb(testDatabaseUrl());

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

  // GH #347: nothing used to bind a ciphertext to the user_id it was sealed
  // for, so anyone able to write ciphertext/iv/key_version — a Postgres write
  // access, not the master key — could move user A's row onto user B's and
  // have get() decrypt it under B's identity. The AAD (`mail:<userId>`) makes
  // that fail instead: it changes with the row it is meant to protect, so a
  // moved ciphertext no longer authenticates.
  it("refuses to decrypt a credential moved from a different user's row", async () => {
    const users = createUsersRepo(sql);
    const key = await importMasterKey(keyB64());
    const creds = createMailCredentialsRepo(sql, key);
    const victim = await users.create({
      email: `victim-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Victim",
    });
    const attacker = await users.create({
      email: `attacker-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Attacker",
    });
    await creds.set(victim.id, "victim-mailbox-secret");

    // Simulates the attack this closes: a database write moves victim's
    // encrypted columns onto attacker's row, keyed by the same user_id column
    // get() reads. Direct SQL rather than the repo, because the repo has no
    // "copy onto another row" operation — this is exactly the write path the
    // repo API does not offer and that AAD defends against regardless.
    const [victimRow] = await sql<
      { ciphertext: Uint8Array; iv: Uint8Array; key_version: number }[]
    >`select ciphertext, iv, key_version from mail_credentials where user_id = ${victim.id}`;
    await sql`
      insert into mail_credentials (user_id, ciphertext, iv, key_version)
      values (${attacker.id}, ${victimRow!.ciphertext}, ${victimRow!.iv}, ${victimRow!.key_version})
      on conflict (user_id) do update set
        ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version
    `;

    await expect(creds.get(attacker.id)).rejects.toThrow();
    // The original owner is unaffected.
    expect(await creds.get(victim.id)).toBe("victim-mailbox-secret");
  });

  // Migration safety (GH #347): every row in the database predates AAD. The
  // fallback in crypto.ts's decryptSecret has to keep them readable through
  // the ordinary repo API, with no backfill migration and no key_version bump.
  it("still reads a legacy credential sealed before AAD existed", async () => {
    const users = createUsersRepo(sql);
    const key = await importMasterKey(keyB64());
    const user = await users.create({
      email: `legacy-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Legacy User",
    });
    // Bypasses the repo's set() (which now always binds AAD) to write exactly
    // what every pre-#347 row looks like: sealed with encryptSecret and no
    // additionalData at all.
    const { encryptSecret } = await import("../../modules/credentials/crypto");
    const { ciphertext, iv } = await encryptSecret(key, "legacy-mailbox-secret");
    await sql`
      insert into mail_credentials (user_id, ciphertext, iv, key_version)
      values (${user.id}, ${ciphertext}, ${iv}, 1)
    `;

    const creds = createMailCredentialsRepo(sql, key);
    expect(await creds.get(user.id)).toBe("legacy-mailbox-secret");
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
