/**
 * The server-held JMAP EventSource subscription for ONE shared mailbox
 * (GH #313) — the push half of the hybrid trigger. When Stalwart reports a
 * change to the shared account's Email state, `onChange` runs a delivery
 * cycle at once; the worker's periodic poll only has to cover what this
 * misses (a push lost during a reconnect, a replica that was down).
 *
 * This reopens what docs/design/shared-mailboxes.md once discarded — an
 * EventSource daemon for the group — and the reason it can is the reason the
 * original was discarded: that design needed a GROUP credential to subscribe
 * with, and the spike showed a group principal cannot log in at all. This
 * subscription uses a MEMBER's credential instead, the same one that member's
 * own browser uses on GET /events, elected from the opted-in members by
 * ../delivery.ts electWatcher. Nothing more powerful than a member ever
 * exists in this process.
 *
 * Deliberately NOT registered in ../streams.ts (`mailStreams`): that registry
 * is keyed by user, capped at 8 per user, and torn down by `evictMailSession`
 * on that user's logout — all correct for a browser's stream, all wrong for a
 * subscription that belongs to the shared mailbox and merely borrows a
 * member's credential. A member logging out must not silence the mailbox for
 * everyone else. So this holds its own AbortController and its own silence
 * watchdog (same 90s budget, same three-missed-pings reasoning as streams.ts)
 * and is stopped only by the worker.
 *
 * Reconnects with exponential backoff (5s → 60s cap) rather than at once:
 * every reconnect re-runs the election and dials the provider, and a provider
 * that is down for a minute must not be dialled hundreds of times by every
 * shared mailbox on every replica. The backoff resets once a connection is
 * established. A 401/403 is handled the same way as any other failure — the
 * next connect re-elects, so a member whose credential was revoked simply
 * stops being chosen once the session cache no longer vouches for them
 * (../context.ts, SESSION_CACHE_TTL_MS), and the cycle's own election skips
 * them immediately regardless.
 *
 * Timers and fetch are injected so every path above runs under test with no
 * clock and no socket.
 */

import { log as defaultLog } from "../../../core/logger";
import { jmapAuthHeader, type JmapAuthMode } from "../../../infra/jmap/client";
import { tapEmailStateChanges } from "../contacts-harvest-stream";
import type { ElectedWatcher } from "./delivery";

/** Silence budget before the upstream is declared dead — see streams.ts DEFAULT_STREAM_SILENCE_MS. */
export const WATCHER_SILENCE_MS = 90_000;
export const WATCHER_BACKOFF_INITIAL_MS = 5_000;
export const WATCHER_BACKOFF_MAX_MS = 60_000;

export type WatcherTimers = {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

export const realTimers: WatcherTimers = {
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // A watcher's timers must never be what keeps the process alive: shutdown
    // stops the worker explicitly, and a stray reconnect timer after that
    // would only delay the exit.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export type SharedMailboxWatcher = {
  start(): void;
  stop(): void;
  readonly connected: boolean;
};

export function createSharedMailboxWatcher(input: {
  sharedAccountId: string;
  /** Elects the member whose credential opens the subscription — ../delivery.ts electWatcher. */
  resolveWatcher(): Promise<ElectedWatcher | null>;
  /** Called once per observed change to the shared account's Email state. */
  onChange(sharedAccountId: string): void;
  fetchFn?: typeof fetch;
  authMode?: JmapAuthMode;
  silenceMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  timers?: WatcherTimers;
  log?: LogFn;
}): SharedMailboxWatcher {
  const { sharedAccountId } = input;
  const fetchFn = input.fetchFn ?? fetch;
  const authMode = input.authMode ?? "basic";
  const silenceMs = input.silenceMs ?? WATCHER_SILENCE_MS;
  const backoffInitialMs = input.backoffInitialMs ?? WATCHER_BACKOFF_INITIAL_MS;
  const backoffMaxMs = input.backoffMaxMs ?? WATCHER_BACKOFF_MAX_MS;
  const timers = input.timers ?? realTimers;
  const log = input.log ?? defaultLog;

  let started = false;
  let stopped = false;
  let connected = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let reconnectTimer: unknown;
  let watchdog: unknown;

  function disarmWatchdog(): void {
    if (watchdog !== undefined) timers.clearTimer(watchdog);
    watchdog = undefined;
  }

  function armWatchdog(abort: AbortController): void {
    disarmWatchdog();
    watchdog = timers.setTimer(() => {
      log("warn", "shared mailbox watch: upstream silent, reconnecting", {
        sharedAccountId,
        silenceMs,
      });
      abort.abort();
    }, silenceMs);
  }

  function scheduleReconnect(reason: string): void {
    if (stopped) return;
    const delayMs = Math.min(backoffInitialMs * 2 ** attempt, backoffMaxMs);
    attempt += 1;
    log("debug", "shared mailbox watch: reconnect scheduled", { sharedAccountId, reason, delayMs });
    reconnectTimer = timers.setTimer(() => {
      reconnectTimer = undefined;
      void connect();
    }, delayMs);
  }

  async function connect(): Promise<void> {
    if (stopped) return;

    let elected: ElectedWatcher | null;
    try {
      elected = await input.resolveWatcher();
    } catch (error) {
      log("warn", "shared mailbox watch: election failed", {
        sharedAccountId,
        error: String(error),
      });
      elected = null;
    }
    if (stopped) return;
    if (!elected) {
      scheduleReconnect("no_watcher");
      return;
    }
    if (!elected.session.eventSourceUrl) {
      log("warn", "shared mailbox watch: session advertises no event source", {
        sharedAccountId,
        userId: elected.member.userId,
      });
      scheduleReconnect("no_event_source");
      return;
    }

    // Email only: a Mailbox or Thread change is not new mail, and the tap
    // below ignores everything but the shared account's Email slot anyway.
    const upstreamUrl = elected.session.eventSourceUrl
      .replaceAll("{types}", "Email")
      .replaceAll("{closeafter}", "no")
      .replaceAll("{ping}", "30");

    const abort = new AbortController();
    controller = abort;
    let reason = "upstream_closed";
    try {
      // Armed before the dial, so a provider that accepts the connection and
      // never answers is bounded the same way as one that goes quiet later.
      armWatchdog(abort);
      const upstream = await fetchFn(upstreamUrl, {
        headers: {
          authorization: jmapAuthHeader(elected.auth, authMode),
          accept: "text/event-stream",
        },
        signal: abort.signal,
      });
      if (!upstream.ok || !upstream.body) {
        reason = `status_${upstream.status}`;
        log("warn", "shared mailbox watch: upstream refused the subscription", {
          sharedAccountId,
          userId: elected.member.userId,
          status: upstream.status,
        });
        return;
      }

      attempt = 0;
      connected = true;
      log("info", "shared mailbox watch: subscribed", {
        sharedAccountId,
        userId: elected.member.userId,
      });

      // The same frame parser GET /events uses for the contact harvest: the
      // first Email state observed is a silent baseline, and only a CHANGE to
      // it fires. Anything the cycle would have missed before the baseline is
      // the poll's job.
      const tapped = tapEmailStateChanges({
        source: upstream.body,
        accountId: sharedAccountId,
        onEmailStateChange: () => input.onChange(sharedAccountId),
      });
      const reader = tapped.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        armWatchdog(abort);
      }
    } catch (error) {
      reason = abort.signal.aborted ? "aborted" : "upstream_failed";
      if (!stopped && !abort.signal.aborted) {
        log("warn", "shared mailbox watch: upstream failed", {
          sharedAccountId,
          error: String(error),
        });
      }
    } finally {
      disarmWatchdog();
      connected = false;
      if (controller === abort) controller = null;
      scheduleReconnect(reason);
    }
  }

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      void connect();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== undefined) timers.clearTimer(reconnectTimer);
      reconnectTimer = undefined;
      disarmWatchdog();
      controller?.abort();
      controller = null;
      connected = false;
    },
    get connected(): boolean {
      return connected;
    },
  };
}
