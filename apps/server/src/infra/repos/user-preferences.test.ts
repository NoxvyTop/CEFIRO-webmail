import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createMailCredentialsRepo } from "./mail-credentials";
import { createUserPreferencesRepo } from "./user-preferences";
import { importMasterKey } from "../../modules/credentials/crypto";

const sql = createDb(testDatabaseUrl());
let repo: ReturnType<typeof createUserPreferencesRepo>;
let users: ReturnType<typeof createUsersRepo>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  repo = createUserPreferencesRepo(sql);
  users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
});
afterAll(() => sql.end());

async function freshUserId(): Promise<string> {
  const user = await users.create({
    email: `p-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Pref User",
  });
  return user.id;
}

describe("createUserPreferencesRepo — sharedMailboxCopyOptIn (GH #13/#50 G-3)", () => {
  it("defaults to an empty list for a user with no stored preferences", async () => {
    const userId = await freshUserId();
    const prefs = await repo.get(userId);
    expect(prefs.sharedMailboxCopyOptIn).toEqual([]);
    // The pre-existing fields keep their own defaults.
    expect(prefs.groupMailInMainInbox).toBe(true);
    expect(prefs.customLabels).toEqual([]);
  });

  it("persists a merged opt-in list and reads it back, leaving other fields untouched", async () => {
    const userId = await freshUserId();
    await repo.merge(userId, { groupMailInMainInbox: false });
    const merged = await repo.merge(userId, {
      sharedMailboxCopyOptIn: ["acc-shared", "acc-soporte"],
    });
    expect(merged.sharedMailboxCopyOptIn).toEqual(["acc-shared", "acc-soporte"]);
    // The earlier field is not clobbered by the second merge.
    expect(merged.groupMailInMainInbox).toBe(false);

    const reread = await repo.get(userId);
    expect(reread.sharedMailboxCopyOptIn).toEqual(["acc-shared", "acc-soporte"]);
  });

  it("defensively drops non-string, empty and duplicate entries from a hand-written row", async () => {
    const userId = await freshUserId();
    await sql`
      insert into user_preferences (user_id, preferences)
      values (
        ${userId},
        ${sql.json({
          sharedMailboxCopyOptIn: ["a", "a", "", 5, null, "b"],
          // A non-array customLabels exercises parseCustomLabels' guard too.
          customLabels: "not-an-array",
        })}
      )
    `;
    const prefs = await repo.get(userId);
    expect(prefs.sharedMailboxCopyOptIn).toEqual(["a", "b"]);
    expect(prefs.customLabels).toEqual([]);
  });
});

// GH #314: the user's confirmed trusted-service domains (Tier B). The PUT/DELETE
// routes always write a clean, normalized list, so the parse only guards rows
// written by hand — but those guards matter more than usual here, because
// whatever survives the parse becomes a trust decision on the reader.
describe("createUserPreferencesRepo — trustedServices (GH #314)", () => {
  it("defaults to an empty list for a user with no stored preferences", async () => {
    const userId = await freshUserId();
    const prefs = await repo.get(userId);
    expect(prefs.trustedServices).toEqual([]);
  });

  it("persists a merged domain list and reads it back, leaving other fields untouched", async () => {
    const userId = await freshUserId();
    await repo.merge(userId, { sharedMailboxCopyOptIn: ["acc-shared"] });
    const merged = await repo.merge(userId, { trustedServices: ["partner.test", "billing.example"] });
    expect(merged.trustedServices).toEqual(["partner.test", "billing.example"]);
    expect(merged.sharedMailboxCopyOptIn).toEqual(["acc-shared"]);

    const reread = await repo.get(userId);
    expect(reread.trustedServices).toEqual(["partner.test", "billing.example"]);
  });

  it("defensively lowercases, trims, dedupes and drops non-domain entries from a hand-written row", async () => {
    const userId = await freshUserId();
    await sql`
      insert into user_preferences (user_id, preferences)
      values (
        ${userId},
        ${sql.json({
          trustedServices: [
            " Partner.Test ",
            "partner.test",
            "",
            5,
            null,
            "not a domain",
            "user@evil.test",
            ".leading.dot",
            "com",
            "billing.example",
          ],
        })}
      )
    `;
    const prefs = await repo.get(userId);
    expect(prefs.trustedServices).toEqual(["partner.test", "billing.example"]);
  });

  it("falls back to the empty list when the stored value is not an array", async () => {
    const userId = await freshUserId();
    await sql`
      insert into user_preferences (user_id, preferences)
      values (${userId}, ${sql.json({ trustedServices: "github.com" })})
    `;
    expect((await repo.get(userId)).trustedServices).toEqual([]);
  });

  it("does not expose the internal backfill marker through get()", async () => {
    const userId = await freshUserId();
    await repo.markSentRecipientsBackfilled(userId);
    expect(await repo.get(userId)).not.toHaveProperty("sentRecipientsBackfilledAt");
  });

  it("caps the list at 200 entries so a runaway row cannot make every thread read expensive", async () => {
    const userId = await freshUserId();
    const many = Array.from({ length: 250 }, (_, i) => `svc-${i}.example`);
    await sql`
      insert into user_preferences (user_id, preferences)
      values (${userId}, ${sql.json({ trustedServices: many })})
    `;
    const prefs = await repo.get(userId);
    expect(prefs.trustedServices).toHaveLength(200);
    expect(prefs.trustedServices[0]).toBe("svc-0.example");
    expect(prefs.trustedServices[199]).toBe("svc-199.example");
  });
});

// GH #314: the one-time sent-mailbox backfill records when it ran under the
// same jsonb row (key `sentRecipientsBackfilledAt`), through dedicated methods
// so the marker never leaks into GET /preferences and can never be set by the
// generic PATCH.
describe("createUserPreferencesRepo — sentRecipientsBackfilledAt (GH #314)", () => {
  it("is null until the backfill has been marked", async () => {
    const userId = await freshUserId();
    expect(await repo.getSentRecipientsBackfilledAt(userId)).toBeNull();
  });

  it("records an ISO timestamp once marked, without touching other keys", async () => {
    const userId = await freshUserId();
    await repo.merge(userId, { trustedServices: ["partner.test"] });
    await repo.markSentRecipientsBackfilled(userId);
    const at = await repo.getSentRecipientsBackfilledAt(userId);
    expect(at).not.toBeNull();
    expect(Number.isNaN(Date.parse(at as string))).toBe(false);
    expect((await repo.get(userId)).trustedServices).toEqual(["partner.test"]);
  });

  it("treats a hand-corrupted non-string marker as not backfilled", async () => {
    const userId = await freshUserId();
    await sql`
      insert into user_preferences (user_id, preferences)
      values (${userId}, ${sql.json({ sentRecipientsBackfilledAt: 42 })})
    `;
    expect(await repo.getSentRecipientsBackfilledAt(userId)).toBeNull();
  });
});

// GH #313: the cross-user listing the shared-mailbox copy worker starts every
// cycle from. Only members who can actually take part are returned: active,
// with a mailbox credential to copy with, and with at least one opt-in.
describe("createUserPreferencesRepo — listSharedMailboxCopyOptIns (GH #313)", () => {
  async function optedInUser(accountIds: unknown, options: { credential?: boolean; active?: boolean } = {}) {
    const user = await users.create({
      email: `o-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "Opt-in User",
    });
    if (options.credential !== false) await mailCredentials.set(user.id, "mailbox-pw");
    if (options.active === false) await users.setActive(user.id, false);
    await sql`
      insert into user_preferences (user_id, preferences)
      values (${user.id}, ${sql.json({ sharedMailboxCopyOptIn: accountIds as never })})
    `;
    return user;
  }

  it("lists each opted-in member with their email and account ids", async () => {
    const member = await optedInUser(["acc-a", "acc-b"]);
    const listed = await repo.listSharedMailboxCopyOptIns();
    expect(listed).toContainEqual({
      userId: member.id,
      email: member.email,
      accountIds: ["acc-a", "acc-b"],
    });
  });

  it("leaves out members with no opt-in, an empty opt-in or a non-array value", async () => {
    const none = await freshUserId();
    const empty = await optedInUser([]);
    const malformed = await optedInUser("acc-a");
    const ids = (await repo.listSharedMailboxCopyOptIns()).map((entry) => entry.userId);
    expect(ids).not.toContain(none);
    expect(ids).not.toContain(empty.id);
    expect(ids).not.toContain(malformed.id);
  });

  it("leaves out members without a mailbox credential or deactivated", async () => {
    const noCredential = await optedInUser(["acc-a"], { credential: false });
    const inactive = await optedInUser(["acc-a"], { active: false });
    const ids = (await repo.listSharedMailboxCopyOptIns()).map((entry) => entry.userId);
    expect(ids).not.toContain(noCredential.id);
    expect(ids).not.toContain(inactive.id);
  });

  it("applies the same defensive parse as get(), dropping a member whose list parses to nothing", async () => {
    const dirty = await optedInUser(["acc-a", "acc-a", "", 5, null]);
    const junk = await optedInUser(["", 5, null]);
    const listed = await repo.listSharedMailboxCopyOptIns();
    expect(listed.find((entry) => entry.userId === dirty.id)?.accountIds).toEqual(["acc-a"]);
    expect(listed.map((entry) => entry.userId)).not.toContain(junk.id);
  });

  // GH #313: the worker pruned membership against the DELIVERABLE listing
  // above, which filters `active` and joins `mail_credentials` — so a member
  // deactivated for an afternoon, or momentarily without a credential, read
  // as "opted out" and lost their baseline and their owed `pending`/`failed`
  // rows. Membership is what the PREFERENCE says, and nothing else.
  describe("listSharedMailboxCopyOptInMembership", () => {
    it("lists a deactivated or credential-less member whose preference still names the account", async () => {
      const inactive = await optedInUser(["acc-a"], { active: false });
      const noCredential = await optedInUser(["acc-b"], { credential: false });
      const both = await optedInUser(["acc-a", "acc-b"]);
      const listed = await repo.listSharedMailboxCopyOptInMembership();
      expect(listed).toContainEqual({ userId: inactive.id, accountIds: ["acc-a"] });
      expect(listed).toContainEqual({ userId: noCredential.id, accountIds: ["acc-b"] });
      expect(listed).toContainEqual({ userId: both.id, accountIds: ["acc-a", "acc-b"] });
    });

    it("leaves out members with no opt-in, an empty one, a malformed one or one that parses to nothing", async () => {
      const none = await freshUserId();
      const empty = await optedInUser([]);
      const malformed = await optedInUser("acc-a");
      const junk = await optedInUser(["", 5, null]);
      const ids = (await repo.listSharedMailboxCopyOptInMembership()).map((entry) => entry.userId);
      expect(ids).not.toContain(none);
      expect(ids).not.toContain(empty.id);
      expect(ids).not.toContain(malformed.id);
      expect(ids).not.toContain(junk.id);
    });
  });
});
