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
