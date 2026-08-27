import { describe, expect, it, vi } from "vitest";
import { createShutdown, installProcessHandlers } from "./shutdown";

type LogLine = { level: string; msg: string; fields: Record<string, unknown> };

/** Records every log() call so tests can assert on what was reported. */
function recordingLog() {
  const lines: LogLine[] = [];
  const log = (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) => {
    lines.push({ level, msg, fields });
  };
  return { log, lines };
}

/**
 * A server whose graceful stop (`stop(false)`) resolves only when told to, so a
 * test can decide whether draining "finishes in time" or has to be force-closed.
 */
function fakeServer(options: { drains: boolean } = { drains: true }) {
  const calls: boolean[] = [];
  let resolveDrain: (() => void) | undefined;
  const server = {
    pendingRequests: 0,
    stop(closeActiveConnections?: boolean): Promise<void> {
      calls.push(Boolean(closeActiveConnections));
      if (closeActiveConnections) return Promise.resolve();
      if (options.drains) return Promise.resolve();
      // Graceful drain that never finishes on its own — the grace timer must
      // fire and escalate to a forced close.
      return new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
    },
  };
  return { server, calls, finishDrain: () => resolveDrain?.() };
}

function fakeSql() {
  const end = vi.fn((_options?: { timeout?: number }) => Promise.resolve());
  return { sql: { end }, end };
}

describe("createShutdown", () => {
  it("drains the server, closes the database, then exits 0 on a signal", async () => {
    const { server, calls } = fakeServer();
    const { sql, end } = fakeSql();
    const { log } = recordingLog();
    const exit = vi.fn();

    const shutdown = createShutdown({ server, sql, log, graceMs: 50, dbTimeoutMs: 5000, exit });
    await shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(calls).toEqual([false]); // graceful stop, no forced close needed
    expect(end).toHaveBeenCalledTimes(1);
    // postgres.js expresses its end() budget in whole seconds, not milliseconds.
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits non-zero for an uncaught exception after cleaning up", async () => {
    const { server } = fakeServer();
    const { sql, end } = fakeSql();
    const { log } = recordingLog();
    const exit = vi.fn();

    const shutdown = createShutdown({ server, sql, log, graceMs: 50, exit });
    await shutdown({ kind: "uncaughtException", error: new Error("boom") });

    expect(end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("force-closes connections when draining exceeds the grace period", async () => {
    const { server, calls } = fakeServer({ drains: false });
    const { sql, end } = fakeSql();
    const { log, lines } = recordingLog();
    const exit = vi.fn();

    const shutdown = createShutdown({ server, sql, log, graceMs: 20, dbTimeoutMs: 1000, exit });
    await shutdown({ kind: "signal", signal: "SIGINT" });

    expect(calls).toEqual([false, true]); // graceful attempt, then forced close
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("drain"))).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second signal during drain does not re-run cleanup", async () => {
    const drain = fakeServer({ drains: false });
    const { sql, end } = fakeSql();
    const { log } = recordingLog();
    const exit = vi.fn();

    const shutdown = createShutdown({ server: drain.server, sql, log, graceMs: 10_000, exit });

    const first = shutdown({ kind: "signal", signal: "SIGTERM" });
    // A second signal arrives while the first drain is still in flight.
    await shutdown({ kind: "signal", signal: "SIGTERM" });
    drain.finishDrain();
    await first;

    // Only the first invocation ran: one graceful stop, one db close, one exit.
    expect(drain.calls).toEqual([false]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still exits even when closing the database rejects", async () => {
    const { server } = fakeServer();
    const end = vi.fn(() => Promise.reject(new Error("pool stuck")));
    const { log, lines } = recordingLog();
    const exit = vi.fn();

    const shutdown = createShutdown({ server, sql: { end }, log, graceMs: 50, exit });
    await shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(lines.some((l) => l.level === "error")).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });

  // GH #313: background workers (the shared-mailbox copy worker) hold upstream
  // sockets and may be mid-cycle when SIGTERM arrives. They stop FIRST, before
  // the listener drains, so a cycle cannot start a copy against a pool that
  // is about to close.
  describe("stopWorkers hook (GH #313)", () => {
    it("stops the workers before draining the server and closing the database", async () => {
      const order: string[] = [];
      const { sql } = fakeSql();
      const server = {
        pendingRequests: 0,
        stop: vi.fn(() => {
          order.push("server");
          return Promise.resolve();
        }),
      };
      const stopWorkers = vi.fn(async () => {
        order.push("workers");
      });
      const { log } = recordingLog();
      const exit = vi.fn();

      const shutdown = createShutdown({ server, sql, log, graceMs: 50, exit, stopWorkers });
      await shutdown({ kind: "signal", signal: "SIGTERM" });

      expect(order).toEqual(["workers", "server"]);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it("carries on when stopping the workers rejects", async () => {
      const { server, calls } = fakeServer();
      const { sql, end } = fakeSql();
      const { log, lines } = recordingLog();
      const exit = vi.fn();

      const shutdown = createShutdown({
        server,
        sql,
        log,
        graceMs: 50,
        exit,
        stopWorkers: () => Promise.reject(new Error("watcher stuck")),
      });
      await shutdown({ kind: "signal", signal: "SIGTERM" });

      expect(lines.some((l) => l.level === "error" && l.msg.includes("worker"))).toBe(true);
      expect(calls).toEqual([false]);
      expect(end).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it("does not let a worker that never stops block the shutdown past the grace period", async () => {
      const { server, calls } = fakeServer();
      const { sql, end } = fakeSql();
      const { log, lines } = recordingLog();
      const exit = vi.fn();

      const shutdown = createShutdown({
        server,
        sql,
        log,
        graceMs: 20,
        exit,
        stopWorkers: () => new Promise<void>(() => {}),
      });
      await shutdown({ kind: "signal", signal: "SIGTERM" });

      expect(lines.some((l) => l.level === "warn" && l.msg.includes("worker"))).toBe(true);
      expect(calls).toEqual([false]);
      expect(end).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });

    // GH #313, shutdown budget doubled: stopping the workers and draining the
    // listener each raced against the FULL graceMs, so an operator who set
    // SHUTDOWN_GRACE_MS=15000 could wait 30s before the forced close — past
    // the orchestrator's own kill timeout, which turns a graceful stop into a
    // SIGKILL. One deadline now covers both phases.
    it("spends one shared deadline on stopping the workers and draining the server", async () => {
      vi.useFakeTimers();
      try {
        const { server, calls } = fakeServer({ drains: false });
        const { sql } = fakeSql();
        const { log } = recordingLog();
        const exit = vi.fn();

        const shutdown = createShutdown({
          server,
          sql,
          log,
          graceMs: 10_000,
          exit,
          // Stops cleanly, but only after 6 of the 10 seconds.
          stopWorkers: () => new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
        });
        const finished = shutdown({ kind: "signal", signal: "SIGTERM" });

        await vi.advanceTimersByTimeAsync(6_000);
        expect(calls).toEqual([false]); // the drain has started

        // Only the 4s left of the shared budget, not another full 10s.
        await vi.advanceTimersByTimeAsync(3_999);
        expect(calls).toEqual([false]);
        await vi.advanceTimersByTimeAsync(1);
        await finished;

        expect(calls).toEqual([false, true]);
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("still leaves the drain a one-second floor when the workers ate the whole budget", async () => {
      vi.useFakeTimers();
      try {
        const { server, calls } = fakeServer({ drains: false });
        const { sql } = fakeSql();
        const { log } = recordingLog();
        const exit = vi.fn();

        const shutdown = createShutdown({
          server,
          sql,
          log,
          graceMs: 5_000,
          exit,
          stopWorkers: () => new Promise<void>(() => {}),
        });
        const finished = shutdown({ kind: "signal", signal: "SIGTERM" });

        await vi.advanceTimersByTimeAsync(5_000); // the worker stop times out
        expect(calls).toEqual([false]);
        await vi.advanceTimersByTimeAsync(999);
        expect(calls).toEqual([false]);
        await vi.advanceTimersByTimeAsync(1);
        await finished;

        expect(calls).toEqual([false, true]);
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("installProcessHandlers", () => {
  /** A stand-in for `process` that just captures the registered listeners. */
  function fakeProcess() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      proc: {
        on(event: string, handler: (...args: unknown[]) => void) {
          handlers.set(event, handler);
          return this;
        },
      },
      emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      has: (event: string) => handlers.has(event),
    };
  }

  it("routes SIGTERM and SIGINT to a signal shutdown", () => {
    const { proc, emit } = fakeProcess();
    const shutdown = vi.fn();
    const { log } = recordingLog();

    installProcessHandlers({ shutdown, log, process: proc });
    emit("SIGTERM");
    emit("SIGINT");

    expect(shutdown).toHaveBeenNthCalledWith(1, { kind: "signal", signal: "SIGTERM" });
    expect(shutdown).toHaveBeenNthCalledWith(2, { kind: "signal", signal: "SIGINT" });
  });

  it("logs and shuts down on an uncaught exception", () => {
    const { proc, emit } = fakeProcess();
    const shutdown = vi.fn();
    const { log, lines } = recordingLog();

    installProcessHandlers({ shutdown, log, process: proc });
    const error = new Error("kaboom");
    emit("uncaughtException", error);

    expect(lines.some((l) => l.level === "error" && l.msg.includes("uncaught"))).toBe(true);
    expect(shutdown).toHaveBeenCalledWith({ kind: "uncaughtException", error });
  });

  it("logs an unhandled rejection but does not shut down", () => {
    const { proc, emit } = fakeProcess();
    const shutdown = vi.fn();
    const { log, lines } = recordingLog();

    installProcessHandlers({ shutdown, log, process: proc });
    emit("unhandledRejection", new Error("dangling"));

    expect(lines.some((l) => l.level === "error" && l.msg.includes("rejection"))).toBe(true);
    expect(shutdown).not.toHaveBeenCalled();
  });
});
