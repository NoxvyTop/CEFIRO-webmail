import { AsyncLocalStorage } from "node:async_hooks";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL: Level = "info";

/**
 * Fields every line written inside the current request carries — today the
 * traceId, which is what makes a diagnostic line findable from the id the
 * client was given (GH #219).
 */
export type LogContext = Record<string, unknown>;

// AsyncLocalStorage rather than a logger threaded through every signature: the
// lines with the most diagnostic value sit several layers below the handler
// (the outbound deadline in core/deadline.ts, the sieve sync, the contacts
// harvest, the AI adapter), and none of them should have to take a logger
// argument — nor be reachable only from a request. Anything running outside a
// request simply logs without the context, exactly as before.
const contextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Runs `run` with `context` attached to every log line it produces, including
 * the ones written from async work it starts (awaited calls, timers such as the
 * outbound deadline's).
 */
export function withLogContext<T>(context: LogContext, run: () => T): T {
  return contextStorage.run(context, run);
}

/**
 * The context in force right now, for work that will resume outside it — the
 * contacts harvest runs off the SSE stream, long after the handler that started
 * it returned, and must still be attributable to that request. Capture here,
 * re-establish with withLogContext there.
 */
export function currentLogContext(): LogContext {
  return contextStorage.getStore() ?? {};
}

function parseLevel(raw: string | undefined): Level {
  const candidate = raw?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === candidate) ?? DEFAULT_LEVEL;
}

// Read from the environment on each call, memoized on the raw string, so
// LOG_LEVEL can be set for a process without a config reload and tests can
// exercise it without resetting module state. An unrecognized value falls back
// to the default rather than silencing the server.
let cachedRaw: string | undefined;
let cachedLevel: Level | undefined;

function minSeverity(): number {
  const raw = process.env.LOG_LEVEL;
  if (cachedLevel === undefined || raw !== cachedRaw) {
    cachedRaw = raw;
    cachedLevel = parseLevel(raw);
  }
  return SEVERITY[cachedLevel];
}

export function log(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (SEVERITY[level] < minSeverity()) return;
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    // Explicit fields last: a call site that passes its own traceId (the access
    // log, the error envelope) keeps winning over the ambient one.
    ...contextStorage.getStore(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
