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
