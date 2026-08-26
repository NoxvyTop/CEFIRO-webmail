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

/** Moves a member's baseline back by `ms`, standing in for an opt-in that long ago. */
async function ageBaseline(userId: string, accountId: string, ms: number): Promise<void> {
  await sql`
    update shared_mailbox_member_state
    set baselined_at = now() - make_interval(secs => ${ms}::double precision / 1000)
    where user_id = ${userId} and shared_account_id = ${accountId}
  `;
}

// GH #313: who is allowed to receive copies for an account, and from WHEN. A
// member first seen in a cycle is baselined at that moment, and receives only
// the messages the shared mailbox received from then on — so opting in never
// back-fills the mail that was already there, however many pages of backlog
// the cursor still has to drain.
//
// This replaced an opaque per-member Email STATE: the state was recorded but
// never compared, so it only ever excluded the joiner from one cycle, and a
// backlog longer than that cycle's page cap reached them from the next one.
describe("createSharedMailboxCopiesRepo — member baseline (GH #313)", () => {
  it("baselines every member the first time it sees them, now, and nobody twice", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    const before = Date.now();

    const first = await repo.baselineMembers(accountId, [ana, bruno]);
    expect(new Set(first.keys())).toEqual(new Set([ana, bruno]));
    for (const at of first.values()) {
      expect(at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    }

    // The second cycle answers the same baselines: nothing was re-recorded.
    expect(await repo.baselineMembers(accountId, [ana, bruno])).toEqual(first);
  });

  it("baselines only the member who joined an account already being cycled", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    const first = await repo.baselineMembers(accountId, [ana]);
    await ageBaseline(ana, accountId, 3_600_000);

    const second = await repo.baselineMembers(accountId, [ana, bruno]);
    expect(new Set(second.keys())).toEqual(new Set([ana, bruno]));
    // Ana keeps her hour-old baseline; bruno's is fresh.
    expect(Date.now() - second.get(ana)!.getTime()).toBeGreaterThan(3_500_000);
    expect(Date.now() - second.get(bruno)!.getTime()).toBeLessThan(60_000);
    expect(second.get(ana)!.getTime()).toBeLessThan(first.get(ana)!.getTime());
  });

  it("forgets a pruned member, so opting back in baselines them afresh", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    await repo.baselineMembers(accountId, [ana, bruno]);
    await ageBaseline(bruno, accountId, 3_600_000);

    // Bruno opted out: the worker prunes him against the preference listing.
    await repo.pruneMembers(accountId, [ana]);
    expect([...(await repo.baselineMembers(accountId, [ana])).keys()]).toEqual([ana]);
    // ...and coming back does not back-fill what arrived while he was away:
    // his baseline is now, not the hour-old one.
    const rejoined = await repo.baselineMembers(accountId, [ana, bruno]);
    expect(Date.now() - rejoined.get(bruno)!.getTime()).toBeLessThan(60_000);
  });

  // GH #313: a cycle runs for the DELIVERABLE members — active, with a
  // credential — and used to prune against that very list, so a member
  // deactivated for an afternoon lost their baseline and their owed rows
  // inside the first cycle. Pruning is the worker's job alone, against what
  // the preference says; a cycle only records who it sees.
  it("keeps a member it was not asked about: baselining never prunes", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    const first = await repo.baselineMembers(accountId, [ana, bruno]);
    await repo.beginCopy(bruno, accountId, "owed");
    await repo.markFailed(bruno, accountId, "owed", "copy_failed");

    // A cycle for ana alone — bruno is deactivated right now.
    await repo.baselineMembers(accountId, [ana]);

    expect((await repo.baselineMembers(accountId, [ana, bruno])).get(bruno)).toEqual(first.get(bruno));
    expect(await repo.copyStates(bruno, accountId, ["owed"])).toEqual(new Map([["owed", "failed"]]));
  });

  it("keeps the baseline per account and drops it with the user", async () => {
    const a = freshAccountId();
    const b = freshAccountId();
    const ana = await freshUserId();
    await repo.baselineMembers(a, [ana]);
    expect([...(await repo.baselineMembers(b, [ana])).keys()]).toEqual([ana]);

    await sql`delete from users where id = ${ana}`;
    const rows = await sql`select 1 from shared_mailbox_member_state where user_id = ${ana}`;
    expect(rows).toHaveLength(0);
  });

  it("tolerates an account with no members at all", async () => {
    expect(await repo.baselineMembers(freshAccountId(), [])).toEqual(new Map());
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
    await repo.baselineMembers(accountId, [ana, bruno]);
    await ageBaseline(bruno, accountId, 3_600_000);

    await repo.pruneMembers(accountId, [ana]);
    const rejoined = await repo.baselineMembers(accountId, [ana, bruno]);
    expect(Date.now() - rejoined.get(bruno)!.getTime()).toBeLessThan(60_000);

    // Nobody opts in any more: the account keeps no member state at all.
    await repo.pruneMembers(accountId, []);
    const rows = await sql`
      select 1 from shared_mailbox_member_state where shared_account_id = ${accountId}
    `;
    expect(rows).toHaveLength(0);
  });

  // GH #313: a departed member's open ledger rows outlived them. The retry
  // pass back-filled a re-joiner from copies that failed before they opted
  // out, and orphan rows of members who never came back sat at the head of
  // `listRetryable` (oldest first, 100 at a time) starving live members.
  it("drops the pruned member's open ledger rows and keeps their delivered ones", async () => {
    const accountId = freshAccountId();
    const ana = await freshUserId();
    const bruno = await freshUserId();
    await repo.baselineMembers(accountId, [ana, bruno]);
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
    await repo.baselineMembers(accountId, [ana]);

    const accounts = await repo.listAccountIds();
    expect(accounts).toContain(accountId);
    // An account known only by its member rows is listed too: the cursor row
    // is what a lease creates, and a prune must reach both.
    const memberOnly = freshAccountId();
    await repo.baselineMembers(memberOnly, [ana]);
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

  // GH #313: `markFailed` matched on the key alone, so a row that had reached
  // `copied` in between — the member's own manual copy-to-inbox, or a
  // concurrent cycle's confirmation — could be demoted to `failed` by a losing
  // attempt and then re-copied by the retry pass. A confirmed copy is final.
  it("never demotes a confirmed copy to failed", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e1");

    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(await repo.copyStates(member, accountId, ["e1"])).toEqual(new Map([["e1", "copied"]]));
    const rows = await sql<{ attempts: number; last_error: string | null }[]>`
      select attempts, last_error from shared_mailbox_copies
      where user_id = ${member} and shared_account_id = ${accountId} and email_id = 'e1'
    `;
    expect(rows[0]).toMatchObject({ attempts: 0, last_error: null });
  });

  it("lists the failed copies of an account that are still worth retrying", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "copy_failed");

    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).toEqual([
      { userId: member, emailId: "e1", attempts: 1, messageId: null, receivedAt: null },
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
  // GH #313: an Email/copy whose response was lost after the provider had
  // committed it is recorded `failed` and retried, which delivers the message
  // twice. The claim carries the source's Message-ID so the retry can look for
  // the copy in the member's own inbox before making another one.
  it("keeps the source Message-ID on the claim, for the retry to look the copy up", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();

    await repo.beginCopy(member, accountId, "e1", "abc@shared.test");
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(
      await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 }),
    ).toEqual([
      { userId: member, emailId: "e1", attempts: 1, messageId: "abc@shared.test", receivedAt: null },
    ]);

    // The retry claims the row again without knowing the Message-ID — it works
    // from the ledger, not from a page — and must not erase it.
    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(
      (await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 }))[0]
        ?.messageId,
    ).toBe("abc@shared.test");
  });

  // GH #313: the per-member baseline is a timestamp compared against each
  // message's receivedAt. The retry pass works from ledger rows, not from a
  // page, so the claim keeps the source's receivedAt for it to apply the same
  // rule — and, like the Message-ID, a retry's own claim must not erase it.
  it("keeps the source's receivedAt on the claim, for the retry to apply the baseline rule", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    const receivedAt = new Date("2026-08-20T10:00:00.000Z");

    await repo.beginCopy(member, accountId, "e1", "abc@shared.test", receivedAt);
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(
      (await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 }))[0]
        ?.receivedAt,
    ).toEqual(receivedAt);

    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(
      (await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 }))[0]
        ?.receivedAt,
    ).toEqual(receivedAt);
  });

  it("records no Message-ID for a source that carries none", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.beginCopy(member, accountId, "e1", null);
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(
      (await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 }))[0]
        ?.messageId,
    ).toBeNull();
  });

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
    ).toEqual([{ userId: member, emailId: "e-mine", attempts: 1, messageId: null, receivedAt: null }]);
    // Nobody deliverable is not "everybody": an empty list retries nothing.
    expect(await repo.listRetryable(accountId, { userIds: [], maxAttempts: 5, limit: 100 })).toEqual(
      [],
    );
  });

  // GH #313: a member the cycle cannot deliver to — deactivated, momentarily
  // without a credential, or whose session lookup throws — used to be skipped
  // with nothing written while the cursor advanced past their mail, so that
  // page was lost for them for good. `recordOwed` is the trail the cycle
  // leaves instead: a `failed` row with NO attempt spent, which the retry pass
  // delivers the moment they are deliverable again.
  it("records an owed copy as failed without spending an attempt", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    const receivedAt = new Date("2026-08-20T10:00:00.000Z");

    await repo.recordOwed(member, accountId, [
      { emailId: "e1", messageId: "abc@shared.test", receivedAt },
    ]);

    expect(await repo.copyStates(member, accountId, ["e1"])).toEqual(new Map([["e1", "failed"]]));
    const rows = await sql<{ attempts: number; last_error: string }[]>`
      select attempts, last_error from shared_mailbox_copies
      where user_id = ${member} and shared_account_id = ${accountId} and email_id = 'e1'
    `;
    expect(rows[0]).toMatchObject({ attempts: 0, last_error: "member unavailable" });
    // The retry pass picks it up with everything it needs: the Message-ID to
    // verify against the member's inbox and the receivedAt for the baseline.
    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).toEqual([
      { userId: member, emailId: "e1", attempts: 0, messageId: "abc@shared.test", receivedAt },
    ]);
  });

  it("never touches a row that already exists, whatever its status", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e-copied");
    await repo.beginCopy(member, accountId, "e-pending", "pending@shared.test");
    await repo.beginCopy(member, accountId, "e-failed", "failed@shared.test");
    await repo.markFailed(member, accountId, "e-failed", "copy_failed");

    await repo.recordOwed(member, accountId, [
      { emailId: "e-copied", messageId: "x@shared.test", receivedAt: new Date() },
      { emailId: "e-pending", messageId: "x@shared.test", receivedAt: new Date() },
      { emailId: "e-failed", messageId: "x@shared.test", receivedAt: new Date() },
    ]);

    expect(await repo.copyStates(member, accountId, ["e-copied", "e-pending", "e-failed"])).toEqual(
      new Map([
        ["e-copied", "copied"],
        ["e-pending", "pending"],
        ["e-failed", "failed"],
      ]),
    );
    // The attempt already spent on the failed row is neither reset nor added
    // to, and its own Message-ID and reason stay as the retry pass left them.
    const rows = await sql<{ attempts: number; last_error: string; message_id: string }[]>`
      select attempts, last_error, message_id from shared_mailbox_copies
      where user_id = ${member} and shared_account_id = ${accountId} and email_id = 'e-failed'
    `;
    expect(rows[0]).toMatchObject({
      attempts: 1,
      last_error: "copy_failed",
      message_id: "failed@shared.test",
    });
  });

  it("tolerates an owed member with nothing to record", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await expect(repo.recordOwed(member, accountId, [])).resolves.toBeUndefined();
    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).toEqual([]);
  });

  // GH #313: the owed rows of a member who never comes back — a credential
  // revoked at the provider — are `failed` with no attempt spent, and the retry
  // pass cannot spend one for them either: it has no session to attempt with.
  // Ordered `updated_at asc limit 100`, they owned the batch of the whole
  // account for ever and nobody else was ever retried. `touchRows` is the
  // rotation that answers it: the tail of the queue, at no cost to the member.
  it("moves a member's failed rows to the tail of the batch without spending an attempt", async () => {
    const accountId = freshAccountId();
    const stuck = await freshUserId();
    const served = await freshUserId();
    await repo.recordOwed(stuck, accountId, [
      { emailId: "e-stuck", messageId: "stuck@shared.test", receivedAt: new Date() },
    ]);
    await repo.beginCopy(served, accountId, "e-mine");
    await repo.markFailed(served, accountId, "e-mine", "copy_failed");
    const batch = { userIds: [stuck, served], maxAttempts: 5, limit: 100 };
    expect((await repo.listRetryable(accountId, batch)).map((r) => r.emailId)).toEqual([
      "e-stuck",
      "e-mine",
    ]);

    await repo.touchRows(stuck, accountId, ["e-stuck"]);

    expect((await repo.listRetryable(accountId, batch)).map((r) => r.emailId)).toEqual([
      "e-mine",
      "e-stuck",
    ]);
    // Rotation is not an attempt: the row keeps everything the retry pass will
    // need when the member is reachable again.
    expect(await repo.listRetryable(accountId, batch)).toContainEqual(
      expect.objectContaining({ userId: stuck, emailId: "e-stuck", attempts: 0 }),
    );
  });

  it("rotates only the failed rows it was given", async () => {
    const member = await freshUserId();
    const accountId = freshAccountId();
    await repo.recordCopy(member, accountId, "e-copied");
    await repo.beginCopy(member, accountId, "e-pending");

    await repo.touchRows(member, accountId, ["e-copied", "e-pending", "e-absent"]);

    expect(await repo.copyStates(member, accountId, ["e-copied", "e-pending"])).toEqual(
      new Map([
        ["e-copied", "copied"],
        ["e-pending", "pending"],
      ]),
    );
    expect(await repo.listRetryable(accountId, { userIds: [member], maxAttempts: 5, limit: 100 })).toEqual(
      [],
    );
    await expect(repo.touchRows(member, accountId, [])).resolves.toBeUndefined();
  });

  // GH #313: the trail of a member nothing can reach grows by a row per message
  // per page, for ever. `countOwed` is what bounds it: the cycle stops writing
  // once this many are outstanding for that member and that account.
  it("counts the outstanding owed rows of one member and account", async () => {
    const member = await freshUserId();
    const other = await freshUserId();
    const accountId = freshAccountId();
    const elsewhere = freshAccountId();
    expect(await repo.countOwed(member, accountId)).toBe(0);

    await repo.recordOwed(member, accountId, [
      { emailId: "e1", messageId: null, receivedAt: new Date() },
      { emailId: "e2", messageId: null, receivedAt: new Date() },
    ]);
    await repo.recordOwed(other, accountId, [
      { emailId: "e1", messageId: null, receivedAt: new Date() },
    ]);
    await repo.recordOwed(member, elsewhere, [
      { emailId: "e1", messageId: null, receivedAt: new Date() },
    ]);
    expect(await repo.countOwed(member, accountId)).toBe(2);

    // A row the retry pass has spent an attempt on is no longer owed: it is an
    // ordinary failed copy, ageing out under the attempt cap.
    await repo.beginCopy(member, accountId, "e1");
    await repo.markFailed(member, accountId, "e1", "copy_failed");
    expect(await repo.countOwed(member, accountId)).toBe(1);

    // Neither is one that was finally delivered.
    await repo.recordCopy(member, accountId, "e2");
    expect(await repo.countOwed(member, accountId)).toBe(0);
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
                  list: ids.map((id) => ({
                    id,
                    mailboxIds: { "inbox-1": true },
                    keywords: {},
                    receivedAt: new Date(Date.now() + 1_000).toISOString(),
                  })),
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
