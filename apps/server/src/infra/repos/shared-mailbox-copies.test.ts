import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { testDatabaseUrl } from "../db/test-db";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createSharedMailboxCopiesRepo } from "./shared-mailbox-copies";

// GH #313: the two small tables behind automatic shared-mailbox copies — the
// per-account Email state cursor and the per-member dedup ledger — plus the
// per-account advisory lock that serialises delivery cycles across replicas.

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
});

describe("createSharedMailboxCopiesRepo — dedup ledger (GH #313)", () => {
  it("answers the empty set for ids nobody has copied", async () => {
    const userId = await freshUserId();
    expect(await repo.hasCopies(userId, freshAccountId(), ["e1", "e2"])).toEqual(new Set());
    expect(await repo.hasCopies(userId, freshAccountId(), [])).toEqual(new Set());
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

describe("createSharedMailboxCopiesRepo — per-account lock (GH #313)", () => {
  it("runs the work and returns its result when the lock is free", async () => {
    const result = await repo.withAccountLock(freshAccountId(), async () => "ran");
    expect(result).toBe("ran");
  });

  it("returns null without running the work while another connection holds the lock", async () => {
    const accountId = freshAccountId();
    // A second pool stands in for another replica: advisory locks are held per
    // session, so contention has to cross connections to mean anything.
    const replica = createDb(url, { poolMax: 1 });
    const replicaRepo = createSharedMailboxCopiesRepo(replica);
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderHasLock: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    const holding = replicaRepo.withAccountLock(accountId, async () => {
      holderHasLock();
      await released;
      return "holder";
    });
    try {
      await lockTaken;
      let ran = false;
      const contended = await repo.withAccountLock(accountId, async () => {
        ran = true;
        return "contender";
      });
      expect(contended).toBeNull();
      expect(ran).toBe(false);
      // Another account is not blocked by this one.
      expect(await repo.withAccountLock(freshAccountId(), async () => "other")).toBe("other");
    } finally {
      release();
      expect(await holding).toBe("holder");
      await replica.end();
    }
    // Released with the holder's transaction, so the next cycle can run.
    expect(await repo.withAccountLock(accountId, async () => "after")).toBe("after");
  });

  it("releases the lock when the work throws", async () => {
    const accountId = freshAccountId();
    await expect(
      repo.withAccountLock(accountId, async () => {
        throw new Error("cycle failed");
      }),
    ).rejects.toThrow("cycle failed");
    expect(await repo.withAccountLock(accountId, async () => "again")).toBe("again");
  });
});
