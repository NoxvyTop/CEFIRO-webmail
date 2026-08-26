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

function harness(initial: OptIn[] = [ana, bruno]) {
  const timers = fakeTimers();
  let optIns = initial;
  let listFailure: Error | null = null;
  const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const cycles: Array<{ sharedAccountId: string; members: SharedCopyMember[] }> = [];
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
      getCursor: async () => null,
      setCursor: async () => {},
      hasCopies: async () => new Set(),
      recordCopy: async () => {},
      withAccountLock: async (_id, fn) => fn(),
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
      if (listFailure) throw listFailure;
      return optIns;
    },
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
      return { status: "delivered", copied: 0, skipped: 0, failed: 0, pages: 1, truncated: false };
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
    setOptIns(next: OptIn[]) {
      optIns = next;
    },
    failListWith(error: Error | null) {
      listFailure = error;
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
      },
      { sharedAccountId: "acc-b", members: [{ userId: ana.userId, email: ana.email }] },
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
      { sharedAccountId: "acc-c", members: [{ userId: bruno.userId, email: bruno.email }] },
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

  it("stop() before start() is harmless", async () => {
    const h = harness();
    await expect(h.worker.stop()).resolves.toBeUndefined();
  });
});
