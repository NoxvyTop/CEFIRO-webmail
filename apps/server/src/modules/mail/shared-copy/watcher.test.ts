import { describe, expect, it } from "vitest";
import type { JmapSession } from "../../../infra/jmap/client";
import type { ElectedWatcher } from "./delivery";
import {
  createSharedMailboxWatcher,
  WATCHER_BACKOFF_INITIAL_MS,
  WATCHER_BACKOFF_MAX_MS,
  WATCHER_SILENCE_MS,
} from "./watcher";

// GH #313: the server-held JMAP EventSource subscription per shared mailbox.
// It is the push half of the hybrid trigger: a StateChange for the shared
// account's Email state runs a delivery cycle at once, and the poll only has
// to cover what this misses. Timers and fetch are injected, so nothing here
// waits on a clock.

const SHARED = "acc-shared";

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
    /** Fires the earliest-scheduled pending timer and returns its delay. */
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

type Connection = {
  url: string;
  headers: Record<string, string>;
  aborted: boolean;
  push(frame: string): void;
  end(): void;
};

function fakeUpstream() {
  const connections: Connection[] = [];
  let nextStatus = 200;
  const encoder = new TextEncoder();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const conn: Connection = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      aborted: false,
      push(frame) {
        controller?.enqueue(encoder.encode(frame));
      },
      end() {
        try {
          controller?.close();
        } catch {}
      },
    };
    init?.signal?.addEventListener("abort", () => {
      conn.aborted = true;
      try {
        controller?.error(new Error("aborted"));
      } catch {}
    });
    connections.push(conn);
    if (nextStatus !== 200) return new Response(null, { status: nextStatus });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return {
    fetchFn,
    connections,
    failNextWith(status: number) {
      nextStatus = status;
    },
    succeed() {
      nextStatus = 200;
    },
  };
}

function elected(email = "ana@noxvytop.com"): ElectedWatcher {
  const session: JmapSession = {
    apiUrl: "https://mail.test/jmap/",
    accountId: `personal-${email}`,
    eventSourceUrl: "https://mail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    accounts: [
      { id: `personal-${email}`, name: "Me", isPersonal: true },
      { id: SHARED, name: "Shared", isPersonal: false },
    ],
  };
  return { member: { userId: `uid-${email}`, email }, auth: { email, password: "pw" }, session };
}

function stateFrame(state: string, accountId = SHARED): string {
  return `event: state\ndata: ${JSON.stringify({
    "@type": "StateChange",
    changed: { [accountId]: { Email: state } },
  })}\n\n`;
}

/** Lets the watcher's awaited steps (election, fetch, first read) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options: { resolve?: () => Promise<ElectedWatcher | null> } = {}) {
  const timers = fakeTimers();
  const upstream = fakeUpstream();
  const changes: string[] = [];
  const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  let elections = 0;
  const watcher = createSharedMailboxWatcher({
    sharedAccountId: SHARED,
    resolveWatcher: async () => {
      elections += 1;
      return options.resolve ? options.resolve() : elected();
    },
    onChange: (accountId) => {
      changes.push(accountId);
    },
    fetchFn: upstream.fetchFn,
    timers: timers.timers,
    log: (level, msg, fields = {}) => {
      logs.push({ level, msg, fields });
    },
  });
  return {
    watcher,
    timers,
    upstream,
    changes,
    logs,
    get elections() {
      return elections;
    },
  };
}

describe("createSharedMailboxWatcher — subscription (GH #313)", () => {
  it("opens the elected member's EventSource for Email changes only, never closing, pinging every 30s", async () => {
    const h = harness();
    h.watcher.start();
    await settle();

    expect(h.upstream.connections).toHaveLength(1);
    const conn = h.upstream.connections[0]!;
    expect(conn.url).toBe("https://mail.test/jmap/eventsource/?types=Email&closeafter=no&ping=30");
    expect(conn.headers.accept).toBe("text/event-stream");
    expect(conn.headers.authorization).toBe(`Basic ${btoa("ana@noxvytop.com:pw")}`);
    expect(h.watcher.connected).toBe(true);
    h.watcher.stop();
  });

  it("presents the credential as Bearer when the provider is configured that way", async () => {
    const timers = fakeTimers();
    const upstream = fakeUpstream();
    const watcher = createSharedMailboxWatcher({
      sharedAccountId: SHARED,
      resolveWatcher: async () => elected(),
      onChange: () => {},
      fetchFn: upstream.fetchFn,
      authMode: "bearer",
      timers: timers.timers,
      log: () => {},
    });
    watcher.start();
    await settle();
    expect(upstream.connections[0]!.headers.authorization).toBe("Bearer pw");
    watcher.stop();
  });

  it("treats the first Email state as a silent baseline and fires once per change after it", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    const conn = h.upstream.connections[0]!;

    conn.push(stateFrame("s1"));
    await settle();
    expect(h.changes).toEqual([]);

    conn.push(stateFrame("s2"));
    await settle();
    expect(h.changes).toEqual([SHARED]);

    // A Mailbox-only change re-sends the same Email state: not new mail.
    conn.push(stateFrame("s2"));
    // Another account's change on the same stream is not this mailbox's.
    conn.push(stateFrame("other-9", "acc-other"));
    conn.push(stateFrame("s3"));
    await settle();
    expect(h.changes).toEqual([SHARED, SHARED]);
    h.watcher.stop();
  });

  it("keeps a keepalive comment from tripping anything", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    h.upstream.connections[0]!.push(": ping\n\n");
    await settle();
    expect(h.changes).toEqual([]);
    expect(h.watcher.connected).toBe(true);
    h.watcher.stop();
  });
});

describe("createSharedMailboxWatcher — lifetime (GH #313)", () => {
  it("aborts a silent upstream after the silence budget and reconnects with the initial backoff", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    // One pending timer: the silence watchdog, armed at connect.
    expect(h.timers.delays()).toEqual([WATCHER_SILENCE_MS]);

    expect(h.timers.fireNext()).toBe(WATCHER_SILENCE_MS);
    await settle();
    expect(h.upstream.connections[0]!.aborted).toBe(true);
    expect(h.watcher.connected).toBe(false);
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("silent"))).toBe(true);
    // The reconnect is scheduled, not immediate.
    expect(h.timers.delays()).toEqual([WATCHER_BACKOFF_INITIAL_MS]);

    h.timers.fireNext();
    await settle();
    expect(h.upstream.connections).toHaveLength(2);
    expect(h.watcher.connected).toBe(true);
    h.watcher.stop();
  });

  it("re-arms the silence watchdog on every byte from the upstream", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    const before = [...h.timers.pending.keys()];
    h.upstream.connections[0]!.push(": ping\n\n");
    await settle();
    const after = [...h.timers.pending.keys()];
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
    h.watcher.stop();
  });

  it("backs off exponentially up to the cap while the provider keeps refusing, and resets once it connects", async () => {
    const h = harness();
    h.upstream.failNextWith(503);
    h.watcher.start();
    await settle();

    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const delay = h.timers.fireNext();
      seen.push(delay!);
      await settle();
    }
    expect(seen).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(WATCHER_BACKOFF_MAX_MS).toBe(60_000);
    expect(h.upstream.connections).toHaveLength(7);
    expect(h.upstream.connections.every((c) => !c.aborted)).toBe(true);

    h.upstream.succeed();
    h.timers.fireNext();
    await settle();
    expect(h.watcher.connected).toBe(true);
    // The upstream closing now costs the initial delay again, not the cap.
    h.upstream.connections.at(-1)!.end();
    await settle();
    expect(h.timers.delays()).toEqual([WATCHER_BACKOFF_INITIAL_MS]);
    h.watcher.stop();
  });

  it("re-elects the watcher on every connect, so a 401 on one member's credential moves on to the next", async () => {
    const h = harness();
    h.upstream.failNextWith(401);
    h.watcher.start();
    await settle();
    expect(h.elections).toBe(1);
    expect(h.logs.some((l) => l.level === "warn" && l.fields.status === 401)).toBe(true);

    h.upstream.succeed();
    h.timers.fireNext();
    await settle();
    expect(h.elections).toBe(2);
    expect(h.watcher.connected).toBe(true);
    h.watcher.stop();
  });

  it("waits out the backoff without dialing when no member can watch, and when the election throws", async () => {
    let answer: () => Promise<ElectedWatcher | null> = async () => null;
    const h = harness({ resolve: () => answer() });
    h.watcher.start();
    await settle();
    expect(h.upstream.connections).toHaveLength(0);
    expect(h.timers.delays()).toEqual([WATCHER_BACKOFF_INITIAL_MS]);

    answer = async () => {
      throw new Error("db down");
    };
    h.timers.fireNext();
    await settle();
    expect(h.upstream.connections).toHaveLength(0);
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("elect"))).toBe(true);

    answer = async () => elected();
    h.timers.fireNext();
    await settle();
    expect(h.upstream.connections).toHaveLength(1);
    h.watcher.stop();
  });

  it("skips a session that advertises no EventSource and retries later", async () => {
    const without = elected();
    without.session.eventSourceUrl = "";
    const h = harness({ resolve: async () => without });
    h.watcher.start();
    await settle();
    expect(h.upstream.connections).toHaveLength(0);
    expect(h.timers.delays()).toEqual([WATCHER_BACKOFF_INITIAL_MS]);
    h.watcher.stop();
  });

  it("stop() tears the upstream down, cancels every timer and never reconnects", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    const conn = h.upstream.connections[0]!;

    h.watcher.stop();
    await settle();
    expect(conn.aborted).toBe(true);
    expect(h.watcher.connected).toBe(false);
    expect(h.timers.pending.size).toBe(0);
    expect(h.upstream.connections).toHaveLength(1);
    // Idempotent, and a late start() after stop() is ignored.
    h.watcher.stop();
    h.watcher.start();
    await settle();
    expect(h.upstream.connections).toHaveLength(1);
  });

  it("stop() during the backoff wait cancels the pending reconnect", async () => {
    const h = harness();
    h.upstream.failNextWith(503);
    h.watcher.start();
    await settle();
    expect(h.timers.pending.size).toBe(1);
    h.watcher.stop();
    expect(h.timers.pending.size).toBe(0);
  });

  it("start() is idempotent — a second call does not open a second subscription", async () => {
    const h = harness();
    h.watcher.start();
    h.watcher.start();
    await settle();
    expect(h.upstream.connections).toHaveLength(1);
    h.watcher.stop();
  });
});
