import { describe, expect, it } from "vitest";
import type { JmapClient, JmapSession } from "../../../infra/jmap/client";
import type { DeliveryDeps, SharedCopyMember } from "./delivery";
import { createSharedCopyWorker } from "./worker";

// GH #313: the worker is the scheduler around the delivery cycle — it learns
// who opted into what, runs a cycle per shared account on start and on every
// poll, keeps one push watcher per account open, and folds a push into a
// single-flight cycle. Timers, the cycle and the watcher factory are injected,
// so these run with no clock, no JMAP and no sockets.

function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: {
      setTimer(fn: () => void, ms: number): unknown {
        const id = nextId;
        nextId += 1;
        pending.set(id, { fn, ms });
        return id;
      },
      clearTimer(handle: unknown): void {
        pending.delete(handle as number);
      },
    },
    pending,
    delays(): number[] {
      return [...pending.values()].map((t) => t.ms);
    },
    fireNext(): number | undefined {
      const first = [...pending.entries()][0];
      if (!first) return undefined;
      const [id, timer] = first;
      pending.delete(id);
      timer.fn();
      return timer.ms;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

type OptIn = { userId: string; email: string; accountIds: string[] };

const ana: OptIn = { userId: "uid-ana", email: "ana@noxvytop.com", accountIds: ["acc-a", "acc-b"] };
const bruno: OptIn = { userId: "uid-bruno", email: "bruno@noxvytop.com", accountIds: ["acc-a"] };

function sessionReaching(email: string, accountIds: string[]): JmapSession {
  return {
    apiUrl: "https://mail.test/jmap/",
    accountId: `personal-${email}`,
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "",
    downloadUrl: "",
    accounts: [
      { id: `personal-${email}`, name: "Me", isPersonal: true },
      ...accountIds.map((id) => ({ id, name: id, isPersonal: false })),
    ],
  };
}

type Membership = { userId: string; accountIds: string[] };

function harness(initial: OptIn[] = [ana, bruno], initialMembership?: Membership[]) {
  const timers = fakeTimers();
  let optIns = initial;
  /** What the PREFERENCES say, regardless of active/credential (default: the same people). */
  let membership: Membership[] =
    initialMembership ?? initial.map(({ userId, accountIds }) => ({ userId, accountIds }));
  let listFailure: Error | null = null;
  /** A pending opt-in listing, when the test wants stop() to land during it. */
  let listGate: Promise<void> | null = null;
  /** Accounts the state store already knows about, and the prunes it received. */
  let knownAccounts: string[] = ["acc-a", "acc-b"];
  let pruneFailure: Error | null = null;
  const pruneFailFor = new Set<string>();
  /** A pending prune per account, when the test wants stop() to land during it. */
  const pruneGates = new Map<string, Promise<void>>();
  const prunes: Array<{ accountId: string; userIds: string[] }> = [];
  const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const cycles: Array<{
    sharedAccountId: string;
    members: SharedCopyMember[];
    owedMembers?: string[];
  }> = [];
  const blocked = new Map<string, () => void>();
  const throwFor = new Set<string>();
  const watchers = new Map<
    string,
    { onChange: (id: string) => void; resolveWatcher: () => Promise<unknown>; stopped: number }
  >();
  const opened: string[] = [];
  const jmap: JmapClient = {
    getSession: async () => {
      throw new Error("unused");
    },
    request: async () => [],
    uploadBlob: async () => "",
  };
  const delivery: DeliveryDeps = {
    jmap,
    copies: {
      getState: async () => ({ emailState: null, lastCycleAt: null }),
      markCycleAttempt: async () => {},
      listAccountIds: async () => knownAccounts,
      pruneMembers: async (accountId, userIds) => {
        await pruneGates.get(accountId);
        if (pruneFailure) throw pruneFailure;
        if (pruneFailFor.has(accountId)) throw new Error(`prune ${accountId} blew up`);
        prunes.push({ accountId, userIds });
      },
      baselineMembers: async () => new Map(),
      setCursor: async () => {},
      copyStates: async () => new Map(),
      beginCopy: async () => {},
      markCopied: async () => {},
      markFailed: async () => {},
      recordOwed: async () => {},
      touchRows: async () => {},
      countOwed: async () => 0,
      listRetryable: async () => [],
      acquireLease: async () => true,
      renewLease: async () => true,
      releaseLease: async () => {},
    },
    getMailSession: async (member) => ({
      ok: true,
      auth: { email: member.email, password: "pw" },
      session: sessionReaching(
        member.email,
        optIns.find((o) => o.userId === member.userId)?.accountIds ?? [],
      ),
    }),
    log: () => {},
  };
  const worker = createSharedCopyWorker({
    delivery,
    listOptIns: async () => {
      await listGate;
      if (listFailure) throw listFailure;
      return optIns;
    },
    listOptInMembership: async () => membership,
    pollMs: 300_000,
    timers: timers.timers,
    log: (level, msg, fields = {}) => {
      logs.push({ level, msg, fields });
    },
    runCycle: async (_deps, input) => {
      cycles.push(input);
      if (throwFor.has(input.sharedAccountId)) throw new Error(`cycle ${input.sharedAccountId} blew up`);
      await new Promise<void>((resolve) => {
        if (blocked.has(input.sharedAccountId)) {
          const previous = blocked.get(input.sharedAccountId)!;
          blocked.set(input.sharedAccountId, () => {
            previous();
            resolve();
          });
        } else resolve();
      });
      return {
        status: "delivered",
        copied: 0,
        skipped: 0,
        failed: 0,
        unresolved: 0,
        owed: 0,
        dropped: 0,
        pages: 1,
        truncated: false,
      };
    },
    openWatcher: (input) => {
      opened.push(input.sharedAccountId);
      const entry = { onChange: input.onChange, resolveWatcher: input.resolveWatcher, stopped: 0 };
      watchers.set(input.sharedAccountId, entry);
      return {
        stop() {
          entry.stopped += 1;
        },
      };
    },
  });
  return {
    worker,
    timers,
    logs,
    cycles,
    opened,
    watchers,
    throwFor,
    prunes,
    /** Sets the deliverable opt-ins; the membership follows unless `keepMembership`. */
    setOptIns(next: OptIn[], options: { keepMembership?: boolean } = {}) {
      optIns = next;
      if (!options.keepMembership) {
        membership = next.map(({ userId, accountIds }) => ({ userId, accountIds }));
      }
    },
    setMembership(next: Membership[]) {
      membership = next;
    },
    setKnownAccounts(next: string[]) {
      knownAccounts = next;
    },
    failListWith(error: Error | null) {
      listFailure = error;
    },
    failPruneWith(error: Error | null) {
      pruneFailure = error;
    },
    failPruneFor(accountId: string) {
      pruneFailFor.add(accountId);
    },
    /** Makes the next opt-in listing hang until `release()` is called. */
    blockList(): () => void {
      let release!: () => void;
      listGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        listGate = null;
        release();
      };
    },
    /** Makes the prune of `accountId` hang until `release()` is called. */
    blockPrune(accountId: string): () => void {
      let release!: () => void;
      pruneGates.set(
        accountId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        pruneGates.delete(accountId);
        release();
      };
    },
    /** Makes the next cycle for `accountId` hang until `release()` is called. */
    block(accountId: string): () => void {
      blocked.set(accountId, () => {});
      return () => {
        const release = blocked.get(accountId);
        blocked.delete(accountId);
        release?.();
      };
    },
  };
}

describe("createSharedCopyWorker — start and poll (GH #313)", () => {
  it("runs one cycle per opted-into account on start, with that account's members, and opens a watcher each", async () => {
    const h = harness();
    h.worker.start();
    await settle();

    expect(h.cycles).toEqual([
      {
        sharedAccountId: "acc-a",
        members: [
          { userId: ana.userId, email: ana.email },
          { userId: bruno.userId, email: bruno.email },
        ],
        owedMembers: [],
      },
      {
        sharedAccountId: "acc-b",
        members: [{ userId: ana.userId, email: ana.email }],
        owedMembers: [],
      },
    ]);
    expect(h.opened).toEqual(["acc-a", "acc-b"]);
    expect(h.worker.watching).toEqual(["acc-a", "acc-b"]);
    await h.worker.stop();
  });

  it("schedules the next poll only after the pass finished, at the configured interval", async () => {
    const h = harness();
    const release = h.block("acc-a");
    h.worker.start();
    await settle();
    expect(h.timers.delays()).toEqual([]);
    release();
    await settle();
    expect(h.timers.delays()).toEqual([300_000]);
    await h.worker.stop();
  });

  it("re-lists the opt-ins on every poll, opening watchers for new accounts and closing the orphaned ones", async () => {
    const h = harness();
    h.worker.start();
    await settle();

    h.setOptIns([{ ...bruno, accountIds: ["acc-c"] }]);
    h.timers.fireNext();
    await settle();

    expect(h.cycles.slice(2)).toEqual([
      {
        sharedAccountId: "acc-c",
        members: [{ userId: bruno.userId, email: bruno.email }],
        owedMembers: [],
      },
    ]);
    expect(h.watchers.get("acc-a")!.stopped).toBe(1);
    expect(h.watchers.get("acc-b")!.stopped).toBe(1);
    expect(h.watchers.get("acc-c")!.stopped).toBe(0);
    expect(h.worker.watching).toEqual(["acc-c"]);
    await h.worker.stop();
  });

  it("does nothing, and opens nothing, while nobody has opted in", async () => {
    const h = harness([]);
    h.worker.start();
    await settle();
    expect(h.cycles).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.timers.delays()).toEqual([300_000]);
    await h.worker.stop();
  });

  it("logs a failing cycle and still runs the other accounts and the next poll", async () => {
    const h = harness();
    h.throwFor.add("acc-a");
    h.worker.start();
    await settle();

    expect(h.cycles.map((c) => c.sharedAccountId)).toEqual(["acc-a", "acc-b"]);
    expect(
      h.logs.some((l) => l.level === "error" && l.fields.sharedAccountId === "acc-a"),
    ).toBe(true);
    expect(h.timers.delays()).toEqual([300_000]);
    await h.worker.stop();
  });

  it("logs a failing opt-in listing and tries again on the next poll, keeping its watchers", async () => {
    const h = harness();
    h.worker.start();
    await settle();

    h.failListWith(new Error("db away"));
    h.timers.fireNext();
    await settle();
    expect(h.logs.some((l) => l.level === "error" && l.msg.includes("opt-in"))).toBe(true);
    expect(h.cycles).toHaveLength(2);
    expect(h.worker.watching).toEqual(["acc-a", "acc-b"]);
    expect(h.timers.delays()).toEqual([300_000]);

    h.failListWith(null);
    h.timers.fireNext();
    await settle();
    expect(h.cycles).toHaveLength(4);
    await h.worker.stop();
  });

  it("hands each watcher an election over the account's current members", async () => {
    const h = harness();
    h.worker.start();
    await settle();
    const electedA = (await h.watchers.get("acc-a")!.resolveWatcher()) as { member: SharedCopyMember };
    expect(electedA.member).toEqual({ userId: ana.userId, email: ana.email });
    // ana is the only member of acc-b; drop her opt-in and the election for
    // acc-b must see the new membership without the watcher being rebuilt.
    h.setOptIns([bruno, { ...ana, accountIds: ["acc-b"] }]);
    h.timers.fireNext();
    await settle();
    const electedA2 = (await h.watchers.get("acc-a")!.resolveWatcher()) as { member: SharedCopyMember };
    expect(electedA2.member).toEqual({ userId: bruno.userId, email: bruno.email });
    await h.worker.stop();
  });
});

// GH #313: the member prune lived inside the delivery cycle, and a cycle only
// runs for an account that still has members. The last member to opt out kept
// their baseline row and their open ledger rows for ever: opting back in
// resumed across the gap instead of starting fresh, and the retry pass
// back-filled them from copies that failed before they left. Reconciling every
// account the state store knows about, on every poll, is what makes the prune
// reach an account nobody is cycling any more.
describe("createSharedCopyWorker — membership reconcile (GH #313)", () => {
  it("prunes every account it holds state for against the current opt-ins", async () => {
    const h = harness();
    h.worker.start();
    await settle();

    expect(h.prunes).toEqual([
      { accountId: "acc-a", userIds: [ana.userId, bruno.userId] },
      { accountId: "acc-b", userIds: [ana.userId] },
    ]);
    await h.worker.stop();
  });

  it("prunes an account whose last member opted out, with no cycle to do it", async () => {
    const h = harness();
    h.worker.start();
    await settle();
    h.prunes.length = 0;
    const cyclesBefore = h.cycles.length;

    // Nobody opts into acc-b any more: no cycle will ever run for it again.
    h.setOptIns([{ ...ana, accountIds: ["acc-a"] }, bruno]);
    h.timers.fireNext();
    await settle();

    expect(h.prunes).toContainEqual({ accountId: "acc-b", userIds: [] });
    expect(h.cycles.slice(cyclesBefore).map((c) => c.sharedAccountId)).toEqual(["acc-a"]);
    await h.worker.stop();
  });

  it("reconciles before the cycles, so a departed member is gone by the time one runs", async () => {
    const h = harness();
    h.worker.start();
    await settle();
    expect(h.prunes).toHaveLength(2);
    expect(h.cycles).toHaveLength(2);
    // Both prunes landed before either cycle: the prune list is complete at
    // the moment the first cycle is queued.
    expect(h.prunes.map((p) => p.accountId)).toEqual(["acc-a", "acc-b"]);
    await h.worker.stop();
  });

  it("logs a failing reconcile and still runs the cycles and the next poll", async () => {
    const h = harness();
    h.failPruneWith(new Error("db away"));
    h.worker.start();
    await settle();

    expect(h.logs.some((l) => l.level === "error" && l.msg.includes("reconcile"))).toBe(true);
    expect(h.cycles.map((c) => c.sharedAccountId)).toEqual(["acc-a", "acc-b"]);
    expect(h.timers.delays()).toEqual([300_000]);
    await h.worker.stop();
  });

  // GH #313: the prune ran against the DELIVERABLE listing (active users with
  // a credential), so a member deactivated for an afternoon read as "opted
  // out" and lost their baseline and their owed rows. Membership is what the
  // preference says; deliverability is a separate, narrower question.
  it("prunes against the preference membership, not the deliverable list", async () => {
    // Bruno is deactivated right now: still a member, not deliverable.
    const h = harness([ana], [
      { userId: ana.userId, accountIds: ana.accountIds },
      { userId: bruno.userId, accountIds: bruno.accountIds },
    ]);
    h.worker.start();
    await settle();

    expect(h.prunes).toContainEqual({ accountId: "acc-a", userIds: [ana.userId, bruno.userId] });
    expect(h.cycles.find((c) => c.sharedAccountId === "acc-a")?.members).toEqual([
      { userId: ana.userId, email: ana.email },
    ]);

    // Reactivated: the next poll delivers to him again, with nothing lost.
    h.setOptIns([ana, bruno], { keepMembership: true });
    h.timers.fireNext();
    await settle();
    expect(h.cycles.at(-2)?.members.map((m) => m.userId)).toEqual([ana.userId, bruno.userId]);
    await h.worker.stop();
  });

  // GH #313: a member the preference names but the deliverable listing leaves
  // out was invisible to the cycle, so the cursor moved past their mail with
  // nothing recorded — the very loss the prune above was fixed to avoid. The
  // cycle is told who it OWES a copy as well as who it can deliver to.
  it("tells the cycle which members it owes a copy: named by the preference, not deliverable today", async () => {
    // Bruno is deactivated right now: a member of acc-a, nothing to copy with.
    const h = harness([ana], [
      { userId: ana.userId, accountIds: ana.accountIds },
      { userId: bruno.userId, accountIds: bruno.accountIds },
    ]);
    h.worker.start();
    await settle();

    expect(h.cycles).toEqual([
      {
        sharedAccountId: "acc-a",
        members: [{ userId: ana.userId, email: ana.email }],
        owedMembers: [bruno.userId],
      },
      {
        sharedAccountId: "acc-b",
        members: [{ userId: ana.userId, email: ana.email }],
        owedMembers: [],
      },
    ]);
    await h.worker.stop();
  });

  it("still prunes a member whose preference no longer names the account", async () => {
    const h = harness();
    h.worker.start();
    await settle();
    h.prunes.length = 0;

    h.setMembership([{ userId: ana.userId, accountIds: ["acc-a"] }]);
    h.timers.fireNext();
    await settle();
    expect(h.prunes).toContainEqual({ accountId: "acc-a", userIds: [ana.userId] });
    expect(h.prunes).toContainEqual({ accountId: "acc-b", userIds: [] });
    await h.worker.stop();
  });

  // GH #313: one failing prune aborted the whole reconcile, so the accounts
  // after it in the listing were not pruned until the next poll.
  it("logs a prune that fails for one account and still prunes the others", async () => {
    const h = harness();
    h.failPruneFor("acc-a");
    h.worker.start();
    await settle();

    expect(h.prunes).toEqual([{ accountId: "acc-b", userIds: [ana.userId] }]);
    expect(
      h.logs.some(
        (l) => l.level === "error" && l.msg.includes("reconcile") && l.fields.sharedAccountId === "acc-a",
      ),
    ).toBe(true);
    expect(h.cycles.map((c) => c.sharedAccountId)).toEqual(["acc-a", "acc-b"]);
    await h.worker.stop();
  });

  it("reconciles nothing when the state store knows no account", async () => {
    const h = harness([]);
    h.setKnownAccounts([]);
    h.worker.start();
    await settle();
    expect(h.prunes).toEqual([]);
    await h.worker.stop();
  });
});

describe("createSharedCopyWorker — push (GH #313)", () => {
  it("runs a cycle for the account a watcher reports a change on", async () => {
    const h = harness();
    h.worker.start();
    await settle();

    h.watchers.get("acc-b")!.onChange("acc-b");
    await settle();
    expect(h.cycles.at(-1)).toEqual({
      sharedAccountId: "acc-b",
      members: [{ userId: ana.userId, email: ana.email }],
      owedMembers: [],
    });
    expect(h.cycles).toHaveLength(3);
    await h.worker.stop();
  });

  it("coalesces pushes that arrive while a cycle is running into one follow-up cycle", async () => {
    const h = harness();
    h.worker.start();
    await settle();

    const release = h.block("acc-a");
    h.watchers.get("acc-a")!.onChange("acc-a");
    await settle();
    expect(h.cycles).toHaveLength(3);
    // Three more changes while that cycle is still in flight.
    h.watchers.get("acc-a")!.onChange("acc-a");
    h.watchers.get("acc-a")!.onChange("acc-a");
    h.watchers.get("acc-a")!.onChange("acc-a");
    await settle();
    expect(h.cycles).toHaveLength(3);

    release();
    await settle();
    // Exactly one follow-up, which picks up everything the three signalled.
    expect(h.cycles).toHaveLength(4);
    expect(h.cycles.at(-1)!.sharedAccountId).toBe("acc-a");
    await h.worker.stop();
  });

  it("ignores a push for an account nobody opts into any more", async () => {
    const h = harness();
    h.worker.start();
    await settle();
    const stale = h.watchers.get("acc-b")!;
    h.setOptIns([bruno]);
    h.timers.fireNext();
    await settle();
    const before = h.cycles.length;
    stale.onChange("acc-b");
    await settle();
    expect(h.cycles).toHaveLength(before);
    await h.worker.stop();
  });
});

describe("createSharedCopyWorker — stop (GH #313)", () => {
  it("stops every watcher, cancels the poll and waits for the in-flight cycle", async () => {
    const h = harness();
    h.worker.start();
    await settle();

    const release = h.block("acc-a");
    h.watchers.get("acc-a")!.onChange("acc-a");
    await settle();

    let stopped = false;
    const stopping = h.worker.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    expect(h.watchers.get("acc-a")!.stopped).toBe(1);
    expect(h.watchers.get("acc-b")!.stopped).toBe(1);
    expect(h.timers.pending.size).toBe(0);

    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(h.worker.watching).toEqual([]);
  });

  it("runs no further cycle after stop(), whatever fires late", async () => {
    const h = harness();
    h.worker.start();
    await settle();
    const stale = h.watchers.get("acc-a")!;
    await h.worker.stop();
    const before = h.cycles.length;

    stale.onChange("acc-a");
    h.worker.start();
    await settle();
    expect(h.cycles).toHaveLength(before);
    expect(h.timers.pending.size).toBe(0);
  });

  // GH #313: `poll()` checked `stopped` only at the top. A stop() that landed
  // while the opt-ins were being listed, or while membership was being
  // reconciled, was followed by `reconcileWatchers()` regardless — which
  // reopened watchers into the map stop() had just emptied, and left sockets
  // and reconnect timers behind a "stopped" worker.
  it("opens no watcher and runs no cycle when stop() lands while the opt-ins are being listed", async () => {
    const h = harness();
    const release = h.blockList();
    h.worker.start();
    await settle();

    let stopped = false;
    const stopping = h.worker.stop().then(() => {
      stopped = true;
    });
    await settle();
    // stop() waits for the poll in flight rather than returning under it.
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(h.opened).toEqual([]);
    expect(h.worker.watching).toEqual([]);
    expect(h.cycles).toEqual([]);
    expect(h.timers.pending.size).toBe(0);
  });

  it("opens no watcher and runs no cycle when stop() lands during the membership reconcile", async () => {
    const h = harness();
    const release = h.blockPrune("acc-a");
    h.worker.start();
    await settle();

    const stopping = h.worker.stop();
    release();
    await stopping;
    // Whatever the released poll still does, it must not reopen anything.
    await settle();
    expect(h.opened).toEqual([]);
    expect(h.worker.watching).toEqual([]);
    expect(h.cycles).toEqual([]);
    expect(h.timers.pending.size).toBe(0);
  });

  it("stop() before start() is harmless", async () => {
    const h = harness();
    await expect(h.worker.stop()).resolves.toBeUndefined();
  });
});
