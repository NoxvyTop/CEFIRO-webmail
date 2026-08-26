import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createSharedMailboxCopiesRepo } from "./shared-mailbox-copies";
import {
  runDeliveryCycle,
  type DeliveryDeps,
} from "../../modules/mail/shared-copy/delivery";
import type {
  JmapClient,
  JmapMethodResponse,
  JmapSession,
} from "../jmap/client";

// GH #313: the small tables behind automatic shared-mailbox copies — the
// per-account Email state cursor and the per-member dedup ledger — plus the
// per-account LEASE that serialises delivery cycles across replicas.

const url = testDatabaseUrl();
const sql = createDb(url);
let repo: ReturnType<typeof createSharedMailboxCopiesRepo>;
let users: ReturnType<typeof createUsersRepo>;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  repo = createSharedMailboxCopiesRepo(sql);
  users = createUsersRepo(sql);
});
afterAll(() => sql.end());

async function freshUserId(): Promise<string> {
  const user = await users.create({
    email: `c-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Copy User",
  });
  return user.id;
}

function freshAccountId(): string {
  return `acc-${crypto.randomUUID()}`;
}

describe("createSharedMailboxCopiesRepo — cursor (GH #313)", () => {
  it("has no cursor for an account never baselined", async () => {
    expect(await repo.getCursor(freshAccountId())).toBeNull();
    expect(await repo.getState(freshAccountId())).toEqual({ emailState: null, lastCycleAt: null });
  });

  it("stores the Email state and overwrites it on the next advance", async () => {
    const accountId = freshAccountId();
    await repo.setCursor(accountId, "s1");
    expect(await repo.getCursor(accountId)).toBe("s1");
    await repo.setCursor(accountId, "s2");
    expect(await repo.getCursor(accountId)).toBe("s2");
  });

  it("keeps cursors per account", async () => {
    const a = freshAccountId();
    const b = freshAccountId();
    await repo.setCursor(a, "a-state");
    await repo.setCursor(b, "b-state");
    expect(await repo.getCursor(a)).toBe("a-state");
    expect(await repo.getCursor(b)).toBe("b-state");
  });

  // GH #313: `last_cycle_at` is informational — delivery resumes from the
  // cursor however old it is — and it means "a cycle was last ATTEMPTED
  // then", so the cycle stamps it as soon as it takes the lease and the
  // cursor advance refreshes it.
  it("stamps an attempted cycle, even before any cursor exists", async () => {
    const accountId = freshAccountId();
    // No row at all: nothing to stamp and nothing to fail on.
    await expect(repo.markCycleAttempt(accountId)).resolves.toBeUndefined();
    expect(await repo.getState(accountId)).toEqual({ emailState: null, lastCycleAt: null });

    // Taking the lease is what creates the row; the stamp lands on it without
    // inventing a cursor the account has not been given yet.
    expect(await repo.acquireLease(accountId, "owner-a", 60_000)).toBe(true);
    await repo.markCycleAttempt(accountId);
    const state = await repo.getState(accountId);
    expect(state.emailState).toBeNull();
    expect(Date.now() - state.lastCycleAt!.getTime()).toBeLessThan(60_000);
  });

  it("refreshes the attempt stamp on a later cycle", async () => {
    const accountId = freshAccountId();
    await repo.setCursor(accountId, "s1");
    await sql`
      update shared_mailbox_copy_state
      set last_cycle_at = now() - interval '2 hours'
      where shared_account_id = ${accountId}
    `;
    await repo.markCycleAttempt(accountId);
    const state = await repo.getState(accountId);
    // The stamp moved; the cursor did not — an attempt is not an advance.
    expect(state.emailState).toBe("s1");
    expect(Date.now() - state.lastCycleAt!.getTime()).toBeLessThan(60_000);
  });

  it("stamps when the cursor was last moved, so the operator sees the last run", async () => {
    const accountId = freshAccountId();
    const before = Date.now();
    await repo.setCursor(accountId, "s1");
    const state = await repo.getState(accountId);
    expect(state.emailState).toBe("s1");
    expect(state.lastCycleAt).toBeInstanceOf(Date);
    expect(state.lastCycleAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);

    await sql`
      update shared_mailbox_copy_state
      set last_cycle_at = now() - interval '2 hours'
      where shared_account_id = ${accountId}
    `;
    const stale = await repo.getState(accountId);
    expect(Date.now() - stale.lastCycleAt!.getTime()).toBeGreaterThan(3_600_000);

    // Advancing again refreshes the stamp.
    await repo.setCursor(accountId, "s2");
    expect(Date.now() - (await repo.getState(accountId)).lastCycleAt!.getTime()).toBeLessThan(
      60_000,
    );
  });
});

// GH #313: who is allowed to receive copies for an account, and from when. A
// member first seen in a cycle is BASELINED in it — the row records the state
// that cycle started from — and only the NEXT cycle delivers to them, so
// opting in never back-fills the mail that was already in the shared mailbox.
describe("createSharedMailboxCopiesRepo — member baseline (GH #313)", () => {
  it("baselines every member the first time it sees them, and nobody twice", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();

    const first = await repo.baselineMembers(accountId, [ana, bruno], "s-1");
    expect(new Set(first)).toEqual(new Set([ana, bruno]));

    // The second cycle knows them: they are deliverable now.
    expect(await repo.baselineMembers(accountId, [ana, bruno], "s-2")).toEqual([]);
  });

  it("baselines only the member who joined an account already being cycled", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    await repo.baselineMembers(accountId, [ana], "s-1");

    expect(await repo.baselineMembers(accountId, [ana, bruno], "s-2")).toEqual([bruno]);
    expect(await repo.baselineMembers(accountId, [ana, bruno], "s-3")).toEqual([]);
  });

  it("keeps the state the member was baselined at", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    await repo.baselineMembers(accountId, [ana], "s-1");
    await repo.baselineMembers(accountId, [ana], "s-2");
    const rows = await sql<{ baselined_state: string }[]>`
      select baselined_state from shared_mailbox_member_state
      where user_id = ${ana} and shared_account_id = ${accountId}
    `;
    expect(rows[0]?.baselined_state).toBe("s-1");
  });

  it("forgets a member who opted out, so opting back in baselines them again", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    await repo.baselineMembers(accountId, [ana, bruno], "s-1");

    // Bruno opted out: he is no longer in the account's member list.
    expect(await repo.baselineMembers(accountId, [ana], "s-2")).toEqual([]);
    // ...and coming back does not back-fill what arrived while he was away.
    expect(await repo.baselineMembers(accountId, [ana, bruno], "s-3")).toEqual([bruno]);
  });

  it("keeps the baseline per account and drops it with the user", async () => {
    const a = freshAccountId();
    const b = freshAccountId();
    const ana = await freshUserId();
    await repo.baselineMembers(a, [ana], "s-1");
    expect(await repo.baselineMembers(b, [ana], "s-1")).toEqual([ana]);

    await sql`delete from users where id = ${ana}`;
    const rows = await sql`select 1 from shared_mailbox_member_state where user_id = ${ana}`;
    expect(rows).toHaveLength(0);
  });

  it("tolerates an account with no members at all", async () => {
    expect(await repo.baselineMembers(freshAccountId(), [], "s-1")).toEqual([]);
  });

  // GH #313: the prune only ever ran inside a delivery cycle, and a cycle only
  // runs for an account that still has members — so the last member to opt out
  // kept their baseline row for ever, and opting back in was a resume across
  // the gap instead of a fresh baseline. It is its own operation now, callable
  // with no cycle and with an empty member list.
  it("prunes the members an account no longer has, down to the last one", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    await repo.baselineMembers(accountId, [ana, bruno], "s-1");

    await repo.pruneMembers(accountId, [ana]);
    expect(await repo.baselineMembers(accountId, [ana, bruno], "s-2")).toEqual([bruno]);

    // Nobody opts in any more: the account keeps no member state at all.
    await repo.pruneMembers(accountId, []);
    const rows = await sql`
      select 1 from shared_mailbox_member_state where shared_account_id = ${accountId}
    `;
    expect(rows).toHaveLength(0);
    expect(new Set(await repo.baselineMembers(accountId, [ana, bruno], "s-3"))).toEqual(
      new Set([ana, bruno]),
    );
  });

  // GH #313: a departed member's open ledger rows outlived them. The retry
  // pass back-filled a re-joiner from copies that failed before they opted
  // out, and orphan rows of members who never came back sat at the head of
  // `listRetryable` (oldest first, 100 at a time) starving live members.
  it("drops the pruned member's open ledger rows and keeps their delivered ones", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    await repo.baselineMembers(accountId, [ana, bruno], "s-1");
    await repo.recordCopy(bruno, accountId, "delivered");
    await repo.beginCopy(bruno, accountId, "claimed");
    await repo.beginCopy(bruno, accountId, "broken");
    await repo.markFailed(bruno, accountId, "broken", "copy_failed");
    await repo.beginCopy(ana, accountId, "ana-broken");
    await repo.markFailed(ana, accountId, "ana-broken", "copy_failed");

    await repo.pruneMembers(accountId, [ana]);

    // The dedup history of what he actually received survives, so a manual
    // copy or a later opt-in is still not delivered twice.
    expect(await repo.copyStates(bruno, accountId, ["delivered", "claimed", "broken"])).toEqual(
      new Map([["delivered", "copied"]]),
    );
    // ...and the member who stayed is untouched.
    expect(await repo.copyStates(ana, accountId, ["ana-broken"])).toEqual(
      new Map([["ana-broken", "failed"]]),
    );
  });

  it("lists the accounts it holds state for, so a worker can reconcile them", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    await repo.setCursor(accountId, "s-1");
    await repo.baselineMembers(accountId, [ana], "s-1");

    const accounts = await repo.listAccountIds();
    expect(accounts).toContain(accountId);
    // An account known only by its member rows is listed too: the cursor row
    // is what a lease creates, and a prune must reach both.
    const memberOnly = freshAccountId();
    await repo.baselineMembers(memberOnly, [ana], "s-1");
    expect(await repo.listAccountIds()).toContain(memberOnly);
    expect(new Set(await repo.listAccountIds()).size).toBe((await repo.listAccountIds()).length);
  });
});

describe("createSharedMailboxCopiesRepo — dedup ledger (GH #313)", () => {
  it("answers the empty set for ids nobody has copied", async () => {
    const userId = await freshUserId();
    expect(await repo.hasCopies(userId, freshAccountId(), ["e1", "e2"])).toEqual(new Set());
    expect(await repo.hasCopies(userId, freshAccountId(), [])).toEqual(new Set());
    expect(await repo.copyStates(userId, freshAccountId(), ["e1"])).toEqual(new Map());
    expect(await repo.copyStates(userId, freshAccountId(), [])).toEqual(new Map());
  });

  // GH #313: the ledger used to be written only AFTER a confirmed Email/copy,
  // which left a window in which the provider had made the copy and nothing
  // recorded it — a crash there delivered the message twice. The row is now
  // claimed as `pending` BEFORE the copy and only then moved to `copied`, so
  // the ambiguous case is a row that stays pending: at most once, never twice.
  it("claims a copy as pending before it is made, then confirms it", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();

    await repo.beginCopy(member, accountId, "e1");
    expect(await repo.copyStates(member, accountId, ["e1"])).toEqual(new Map([["e1", "pending"]]));
    // A pending row is NOT a delivered copy.
    expect(await repo.hasCopy(member, accountId, "e1")).toBe(false);
    expect(await repo.hasCopies(member, accountId, ["e1"])).toEqual(new Set());

    await repo.markCopied(member, accountId, "e1");
    expect(await repo.copyStates(member, accountId, ["e1"])).toEqual(new Map([["e1", "copied"]]));
    expect(await repo.hasCopy(member, accountId, "e1")).toBe(true);
  });

  it("never demotes a confirmed copy back to pending", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e1");
    await repo.beginCopy(member, accountId, "e1");
    expect(await repo.copyStates(member, accountId, ["e1"])).toEqual(new Map([["e1", "copied"]]));
  });

  it("reads the state of a whole page in one query, per member and account", async () => {
    const member = await freshUserId();
    const other = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e1");
    await repo.beginCopy(member, accountId, "e2");

    expect(await repo.copyStates(member, accountId, ["e1", "e2", "e3"])).toEqual(
      new Map([
        ["e1", "copied"],
        ["e2", "pending"],
      ]),
    );
    expect(await repo.copyStates(other, accountId, ["e1", "e2"])).toEqual(new Map());
  });

  it("remembers a recorded copy for that member and account only", async () => {
    const member = await freshUserId();
    const other = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e1");

    expect(await repo.hasCopies(member, accountId, ["e1", "e2"])).toEqual(new Set(["e1"]));
    expect(await repo.hasCopy(member, accountId, "e1")).toBe(true);
    expect(await repo.hasCopy(member, accountId, "e2")).toBe(false);
    // Another member of the same account still needs their own copy, and the
    // same member reading another account has nothing recorded there.
    expect(await repo.hasCopy(other, accountId, "e1")).toBe(false);
    expect(await repo.hasCopy(member, freshAccountId(), "e1")).toBe(false);
  });

  it("tolerates recording the same copy twice (a replayed page after a crash)", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e1");
    await expect(repo.recordCopy(member, accountId, "e1")).resolves.toBeUndefined();
    expect(await repo.hasCopies(member, accountId, ["e1"])).toEqual(new Set(["e1"]));
  });

  it("drops the ledger rows with the user", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e1");
    await sql`delete from users where id = ${member}`;
    const rows = await sql`
      select 1 from shared_mailbox_copies where user_id = ${member}
    `;
    expect(rows).toHaveLength(0);
  });
});

// GH #313: a copy the provider refused or that threw used to be counted, logged
// and forgotten while the cursor moved past it — the member simply never got
// that message, and nothing was left to say so. A failed copy is now a row with
// a try count, and every cycle drains a bounded batch of them before it looks
// at new pages.
describe("createSharedMailboxCopiesRepo — failed copies and retries (GH #313)", () => {
  it("records a failure with its reason and counts the attempt", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();

    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(await repo.copyStates(member, accountId, ["e1"])).toEqual(new Map([["e1", "failed"]]));

    const rows = await sql<{ attempts: number; last_error: string }[]>`
      select attempts, last_error from shared_mailbox_copies
      where user_id = ${member} and shared_account_id = ${accountId} and email_id = 'e1'
    `;
    expect(rows[0]).toMatchObject({ attempts: 1, last_error: "copy_failed" });

    // A second attempt that fails again adds to the count rather than resetting.
    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "over_quota");
    const second = await sql<{ attempts: number; last_error: string }[]>`
      select attempts, last_error from shared_mailbox_copies
      where user_id = ${member} and shared_account_id = ${accountId} and email_id = 'e1'
    `;
    expect(second[0]).toMatchObject({ attempts: 2, last_error: "over_quota" });
  });

  it("lists the failed copies of an account that are still worth retrying", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "copy_failed");

    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).toEqual([
      { userId: member, emailId: "e1", attempts: 1 },
    ]);
    // A pending or a copied row is not a retry candidate.
    await repo.beginCopy(member, accountId, "e2");
    await repo.recordCopy(member, accountId, "e3");
    expect(
      (await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).map((r) => r.emailId),
    ).toEqual(["e1"]);
  });

  it("gives up on a copy that has used its attempts", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await repo.beginCopy(member, accountId, "e1");
      await repo.markFailed(member, accountId, "e1", "copy_failed");
    }
    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).toEqual([]);
    // The row stays, as the record of a copy that will not be delivered.
    expect(await repo.copyStates(member, accountId, ["e1"])).toEqual(new Map([["e1", "failed"]]));
  });

  it("bounds the batch and keeps it to the account asked for", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    const other = freshAccountId();
    for (const emailId of ["e1", "e2", "e3"]) {
      await repo.beginCopy(member, accountId, emailId);
      await repo.markFailed(member, accountId, emailId, "copy_failed");
    }
    await repo.beginCopy(member, other, "e9");
    await repo.markFailed(member, other, "e9", "copy_failed");

    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 2 })).toHaveLength(2);
    expect(
      (await repo.listRetryable(other, { userIds: [member], maxAttempts: 5, limit: 100 })).map((r) => r.emailId),
    ).toEqual(["e9"]);
  });

  // GH #313: the batch is the oldest 100 failed rows of the account, and it
  // used to be taken without asking WHOSE. Rows belonging to members who had
  // opted out — or whom the current cycle is only baselining — sat at the head
  // of it for ever, so a live member's failed copy could never reach the
  // batch at all.
  it("lists only the members the caller can deliver to right now", async () => {
    const accountId = freshAccountId();
    const departed = await freshUserId();
    const member = await freshUserId();
    for (const [userId, emailId] of [
      [departed, "e-old"],
      [member, "e-mine"],
    ] as const) {
      await repo.beginCopy(userId, accountId, emailId);
      await repo.markFailed(userId, accountId, emailId, "copy_failed");
    }

    expect(
      await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 }),
    ).toEqual([{ userId: member, emailId: "e-mine", attempts: 1 }]);
    // Nobody deliverable is not "everybody": an empty list retries nothing.
    expect(await repo.listRetryable(accountId, { userIds: [], maxAttempts: 5, limit: 100 })).toEqual(
      [],
    );
  });

  it("stops listing a failed copy once it finally succeeds", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    await repo.beginCopy(member, accountId, "e1");
    await repo.markCopied(member, accountId, "e1");

    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).toEqual([]);
    expect(await repo.hasCopy(member, accountId, "e1")).toBe(true);
  });
});

// GH #313: the per-account delivery LEASE that replaced the transaction-scoped
// advisory lock. The lock held a transaction open for the whole cycle while the
// cycle's own queries went through the outer pool — a guaranteed deadlock at
// DB_POOL_MAX=1 and an idle-in-transaction connection otherwise. The lease is a
// row, taken and released with ordinary statements, so no transaction spans the
// cycle at all.
describe("createSharedMailboxCopiesRepo — delivery lease (GH #313)", () => {
  const TTL = 60_000;

  it("acquires the lease of an account nobody has ever cycled", async () => {
    expect(await repo.acquireLease(freshAccountId(), "owner-a", TTL)).toBe(true);
  });

  it("refuses a second holder while the lease is live, and keeps accounts apart", async () => {
    const accountId = freshAccountId();
    // A second pool stands in for another replica.
    const replica = createDb(url, { poolMax: 1 });
    const replicaRepo = createSharedMailboxCopiesRepo(replica);
    try {
      expect(await repo.acquireLease(accountId, "owner-a", TTL)).toBe(true);
      expect(await replicaRepo.acquireLease(accountId, "owner-b", TTL)).toBe(false);
      // Another account is not blocked by this one.
      expect(await replicaRepo.acquireLease(freshAccountId(), "owner-b", TTL)).toBe(true);
    } finally {
      await replica.end();
    }
  });

  it("lets the same owner re-take its own lease (a retried or re-entered cycle)", async () => {
    const accountId = freshAccountId();
    expect(await repo.acquireLease(accountId, "owner-a", TTL)).toBe(true);
    expect(await repo.acquireLease(accountId, "owner-a", TTL)).toBe(true);
  });

  it("lets another replica take over an expired lease (a holder that died mid-cycle)", async () => {
    const accountId = freshAccountId();
    // A lease that expired the moment it was taken: exactly what a replica
    // killed mid-cycle leaves behind once its TTL runs out.
    expect(await repo.acquireLease(accountId, "owner-dead", -1_000)).toBe(true);
    expect(await repo.acquireLease(accountId, "owner-b", TTL)).toBe(true);
    // ...and the new holder now owns it.
    expect(await repo.acquireLease(accountId, "owner-c", TTL)).toBe(false);
  });

  it("renews the lease for its owner and refuses to renew for anybody else", async () => {
    const accountId = freshAccountId();
    // About to expire: without the renewal the next acquire would take it.
    expect(await repo.acquireLease(accountId, "owner-a", 50)).toBe(true);
    expect(await repo.renewLease(accountId, "owner-b", TTL)).toBe(false);
    expect(await repo.renewLease(accountId, "owner-a", TTL)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await repo.acquireLease(accountId, "owner-b", TTL)).toBe(false);
  });

  it("releases the lease for its owner only, and frees it for the next cycle", async () => {
    const accountId = freshAccountId();
    expect(await repo.acquireLease(accountId, "owner-a", TTL)).toBe(true);
    // A stale owner releasing must not free somebody else's lease.
    await repo.releaseLease(accountId, "owner-b");
    expect(await repo.acquireLease(accountId, "owner-c", TTL)).toBe(false);

    await repo.releaseLease(accountId, "owner-a");
    expect(await repo.acquireLease(accountId, "owner-c", TTL)).toBe(true);
  });

  it("keeps the cursor untouched while the lease is taken and released", async () => {
    const accountId = freshAccountId();
    await repo.setCursor(accountId, "s-1");
    expect(await repo.acquireLease(accountId, "owner-a", TTL)).toBe(true);
    await repo.releaseLease(accountId, "owner-a");
    expect(await repo.getCursor(accountId)).toBe("s-1");
  });

  it("leaves the cursor null on an account that only ever had a lease", async () => {
    const accountId = freshAccountId();
    expect(await repo.acquireLease(accountId, "owner-a", TTL)).toBe(true);
    expect(await repo.getCursor(accountId)).toBeNull();
  });
});

// GH #313: the whole reason the lease replaced the advisory lock. The lock ran
// the cycle inside `sql.begin`, so the transaction pinned one pooled connection
// while every query of that cycle — the cursor read, the ledger read, the
// cursor write — asked the SAME pool for another one. At DB_POOL_MAX=1 that is
// a deadlock the pool can never break: the cycle waits for a connection the
// transaction will not release until the cycle finishes.
describe("runDeliveryCycle against the real repo with a pool of one (GH #313)", () => {
  it("baselines and then delivers a page with DB_POOL_MAX=1", async () => {
    const single = createDb(url, { poolMax: 1 });
    try {
      const copies = createSharedMailboxCopiesRepo(single);
      const sharedAccountId = freshAccountId();
      const userId = await freshUserId();
      const member = { userId, email: `m-${userId}@noxvytop.com` };
      const session: JmapSession = {
        apiUrl: "https://mail.test/jmap/",
        accountId: "personal-1",
        eventSourceUrl: "https://mail.test/es",
        uploadUrl: "https://mail.test/upload/{accountId}/",
        downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
        accounts: [
          { id: "personal-1", name: "Me", isPersonal: true },
          { id: sharedAccountId, name: "Shared", isPersonal: false },
        ],
      };
      const pages = [{ created: ["e1"], newState: "s-2" }];
      const jmap: JmapClient = {
        getSession: async () => session,
        request: async (_auth, _session, calls) =>
          calls.map(([name, params, callId]): JmapMethodResponse => {
            if (name === "Email/changes") {
              const page = pages.shift();
              if (!page) throw new Error("Email/changes asked for an unscripted page");
              return [
                name,
                { newState: page.newState, hasMoreChanges: false, created: page.created },
                callId,
              ];
            }
            if (name === "Mailbox/query") return [name, { ids: ["inbox-1"] }, callId];
            if (name === "Email/get") {
              const ids = (params.ids ?? []) as string[];
              return [
                name,
                {
                  state: "s-1",
                  list: ids.map((id) => ({ id, mailboxIds: { "inbox-1": true }, keywords: {} })),
                },
                callId,
              ];
            }
            if (name === "Email/copy") return [name, { created: { c: { id: "copy-1" } } }, callId];
            throw new Error(`unexpected JMAP method in test stub: ${name}`);
          }),
        uploadBlob: async () => "blob",
      };
      const deps: DeliveryDeps = {
        jmap,
        copies,
        getMailSession: async () => ({
          ok: true,
          auth: { email: member.email, password: "pw" },
          session,
        }),
        log: () => {},
      };

      // First cycle: no cursor yet, so it only records the current state.
      await expect(runDeliveryCycle(deps, { sharedAccountId, members: [member] })).resolves.toEqual({
        status: "baselined",
        reason: "no_cursor",
      });
      expect(await copies.getCursor(sharedAccountId)).toBe("s-1");

      // Second cycle: a page, a copy and a ledger write — all on the one
      // connection, in sequence, with no transaction spanning any of it.
      await expect(
        runDeliveryCycle(deps, { sharedAccountId, members: [member] }),
      ).resolves.toMatchObject({ status: "delivered", copied: 1 });
      expect(await copies.getCursor(sharedAccountId)).toBe("s-2");
      expect(await copies.hasCopy(userId, sharedAccountId, "e1")).toBe(true);
    } finally {
      await single.end();
    }
  });
});
