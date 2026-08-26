// Graceful shutdown and process-level error handling (GH #193).
//
// Without this, every deploy/restart delivers SIGTERM to the Bun process and
// kills any in-flight `POST /send` mid-sequence (Email/set create issued,
// EmailSubmission still pending) — orphaned drafts, ambiguous sends, clients
// getting connection resets instead of a clean 503, and Postgres connections
// left dangling. This module traps the signals, drains in-flight requests
// within a bounded budget, closes the database pool, and only then exits.

type LogFn = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

/** The slice of Bun's `Server` this module needs (kept minimal for testing). */
export interface Stoppable {
  // stop(false): stop accepting new connections and let in-flight requests
  // finish; the promise resolves once network activity has stopped.
  // stop(true): additionally terminate in-flight requests immediately.
  stop(closeActiveConnections?: boolean): Promise<void>;
  readonly pendingRequests?: number;
}

/** The slice of the postgres.js `sql` client this module needs. */
export interface Closable {
  // NOTE: postgres.js expresses `timeout` in whole SECONDS, not milliseconds.
  end(options?: { timeout?: number }): Promise<void>;
}

export type ShutdownReason =
  | { kind: "signal"; signal: "SIGTERM" | "SIGINT" }
  | { kind: "uncaughtException"; error: unknown };

export interface ShutdownDeps {
  server: Stoppable;
  sql: Closable;
  log: LogFn;
  /** Time in-flight requests get to drain before connections are force-closed. */
  graceMs?: number;
  /** Time the database pool gets to close cleanly before it is destroyed. */
  dbTimeoutMs?: number;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /**
   * Stops background work BEFORE the listener drains (GH #313): the
   * shared-mailbox copy worker holds upstream EventSource sockets and may be
   * mid-cycle, and a cycle that starts a copy while the pool is closing ends
   * with a half-recorded page. Bounded by `graceMs` like the drain itself, and
   * a rejection or an overrun is logged and stepped over — a stuck worker must
   * not keep a deploy from finishing any more than a stuck request may.
   */
  stopWorkers?: () => Promise<void>;
}

// Exported so core/config.ts can default SHUTDOWN_GRACE_MS /
// SHUTDOWN_DB_TIMEOUT_MS to the same numbers it falls back to here (GH #218) —
// one source of truth rather than a copy that can drift.
export const DEFAULT_GRACE_MS = 15_000;
export const DEFAULT_DB_TIMEOUT_MS = 5_000;

/**
 * Builds an idempotent shutdown handler. The first invocation runs the full
 * drain → close-db → exit sequence; any later invocation (e.g. a second SIGTERM
 * while draining) is ignored so cleanup never double-runs.
 */
export function createShutdown(deps: ShutdownDeps): (reason: ShutdownReason) => Promise<void> {
  const graceMs = deps.graceMs && deps.graceMs > 0 ? deps.graceMs : DEFAULT_GRACE_MS;
  const dbTimeoutMs = deps.dbTimeoutMs && deps.dbTimeoutMs > 0 ? deps.dbTimeoutMs : DEFAULT_DB_TIMEOUT_MS;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const { server, sql, log } = deps;

  let started = false;

  async function stopWorkers(): Promise<void> {
    if (!deps.stopWorkers) return;
    const stopping = deps.stopWorkers().catch((error) => {
      log("error", "background worker stop failed", { error: String(error) });
    });
    const timedOut = await raceTimeout(stopping, graceMs);
    if (timedOut) {
      log("warn", "background worker stop timed out; continuing shutdown", { graceMs });
    } else {
      log("info", "background workers stopped", {});
    }
  }

  async function drainServer(): Promise<void> {
    // Bun drains at the connection level: stop(false) stops accepting new
    // connections and resolves once every in-flight request has completed.
    // Bound that wait — a stuck long-lived request must not block the deploy
    // forever — then escalate to a forced close of whatever is left.
    const drained = server.stop(false).catch((error) => {
      log("error", "server stop failed", { error: String(error) });
    });
    const timedOut = await raceTimeout(drained, graceMs);
    if (timedOut) {
      log("warn", "shutdown drain timed out; forcing connection close", {
        graceMs,
        pendingRequests: server.pendingRequests,
      });
      await server.stop(true).catch((error) => {
        log("error", "forced server stop failed", { error: String(error) });
      });
    } else {
      log("info", "in-flight requests drained", {});
    }
  }

  async function closeDb(): Promise<void> {
    const timeoutSeconds = Math.max(1, Math.ceil(dbTimeoutMs / 1000));
    try {
      await sql.end({ timeout: timeoutSeconds });
      log("info", "database connections closed", {});
    } catch (error) {
      log("error", "database shutdown failed", { error: String(error) });
    }
  }

  return async function shutdown(reason: ShutdownReason): Promise<void> {
    if (started) return;
    started = true;

    const code = reason.kind === "signal" ? 0 : 1;
    log("info", "shutdown started", {
      reason: reason.kind,
      signal: reason.kind === "signal" ? reason.signal : undefined,
    });

    await stopWorkers();
    await drainServer();
    await closeDb();

    log("info", "shutdown complete", { code });
    exit(code);
  };
}

/**
 * Wires the shutdown handler to the process:
 *  - SIGTERM / SIGINT           → graceful shutdown, exit 0
 *  - uncaughtException          → log, then shut down and exit non-zero (the
 *                                 process is in an undefined state; cleaning up
 *                                 and leaving is safer than continuing)
 *  - unhandledRejection         → log only, so it is never swallowed silently
 *
 * `process` is injectable so the wiring can be unit-tested without real signals.
 */
export interface ProcessLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Node's general process.on overload
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export function installProcessHandlers(opts: {
  shutdown: (reason: ShutdownReason) => void | Promise<void>;
  log: LogFn;
  process?: ProcessLike;
}): void {
  const proc: ProcessLike = opts.process ?? process;
  const { shutdown, log } = opts;

  proc.on("SIGTERM", () => {
    void shutdown({ kind: "signal", signal: "SIGTERM" });
  });
  proc.on("SIGINT", () => {
    void shutdown({ kind: "signal", signal: "SIGINT" });
  });

  proc.on("uncaughtException", (error: unknown) => {
    log("error", "uncaught exception", {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    void shutdown({ kind: "uncaughtException", error });
  });

  proc.on("unhandledRejection", (reason: unknown) => {
    log("error", "unhandled rejection", { reason: String(reason) });
  });
}

/** Resolves `true` if `ms` elapses first, `false` if `promise` settles first. */
function raceTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    // Don't let the grace timer, on its own, keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
