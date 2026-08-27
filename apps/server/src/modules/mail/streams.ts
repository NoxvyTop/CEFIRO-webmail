/**
 * Lifetime control for the one long-lived route this server has: the JMAP
 * EventSource proxy behind `GET /api/mail/events` (GH #241).
 *
 * That route clears Bun's global idle timeout for its socket, which is correct
 * (GH #204 — the connection legitimately sits idle between Stalwart's 30s
 * pings) but left it with NO deadline of any kind and no bookkeeping:
 *
 * - nothing capped how many a single user could open, so one client in a
 *   reconnect loop could pin an unbounded number of upstream sockets;
 * - a Stalwart that stopped pinging while holding the socket open produced a
 *   connection that was hung, not closed — the exact case the cleared idle
 *   timeout stopped catching, and nothing else was watching;
 * - `evictMailSession` dropped the cached JMAP session but never touched the
 *   streams already running, so a stream opened before logout kept delivering
 *   the user's mail events afterwards, on credentials that had been revoked.
 *
 * This module is the missing bookkeeping: a per-user registration, a silence
 * watchdog owned by THIS process rather than inherited from the upstream's
 * good behaviour, and a handle the session layer can pull.
 *
 * A module-level singleton (`mailStreams`) for the same reason the JMAP session
 * cache in ./context.ts is one: `evictMailSession` is a free function called
 * from logout and from the admin console, and it has to reach the streams of a
 * user it knows only by id.
 */

import { setOpenStreams } from "../../core/metrics";

/**
 * Concurrent event streams one user may hold.
 *
 * Generous on purpose: this is a resource ceiling, not a policy. Each open tab
 * of the webmail holds one stream, and a user with eight tabs of their own
 * mailbox is doing nothing wrong — while a client looping on connect is stopped
 * at eight upstream sockets instead of as many as it can dial. The ninth is
 * refused rather than served by evicting the oldest: an `EventSource` whose
 * connection is closed by the server reconnects immediately, so evicting would
 * turn nine tabs into a permanent reconnect storm, whereas a non-200 makes the
 * browser fail that one connection and stop (HTML spec: a non-200 response
 * fails the connection instead of scheduling a retry).
 */
export const DEFAULT_MAX_STREAMS_PER_USER = 8;

/**
 * How long a stream may receive NOTHING from Stalwart before this process
 * closes it.
 *
 * The route asks Stalwart for `{ping}=30`, so a healthy upstream writes at
 * least every 30 seconds. Three missed pings is the smallest budget that cannot
 * mistake one slow or dropped keepalive for a dead upstream, and it bounds the
 * leak this exists for: a hung connection now costs at most 90 seconds instead
 * of the life of the process. Closing is the right recovery rather than an
 * error page — the client's `EventSource` reconnects on a closed stream, which
 * re-runs the whole auth + session path against a Stalwart that may by then be
 * answering again.
 */
export const DEFAULT_STREAM_SILENCE_MS = 90_000;

export type StreamHandle = {
  /**
   * Aborted when this stream must stop, whatever the reason: the client went
   * away, the upstream went silent, or the session was invalidated. The route
   * hands it to the upstream fetch, so aborting it tears the Stalwart
   * connection down rather than merely abandoning it.
   */
  readonly signal: AbortSignal;
  /** Records that the upstream is alive; restarts the silence watchdog. */
  touch(): void;
  /** Aborts and deregisters. Idempotent — every exit path calls it. */
  close(): void;
};

export type StreamRegistry = {
  /**
   * Registers a stream for `userId`, or returns `null` when that user is
   * already at the cap.
   */
  open(userId: string): StreamHandle | null;
  /**
   * Closes every stream the user has open. Called from `evictMailSession`, so
   * logout, credential rotation and archiving all reach in-flight streams.
   */
  closeUser(userId: string): void;
  /** Streams currently open, across all users — the `/metrics` gauge (GH #240). */
  readonly size: number;
};

export type StreamRegistryOptions = {
  maxPerUser?: number;
  silenceMs?: number;
};

export function createStreamRegistry(options: StreamRegistryOptions = {}): StreamRegistry {
  const maxPerUser = options.maxPerUser ?? DEFAULT_MAX_STREAMS_PER_USER;
  const silenceMs = options.silenceMs ?? DEFAULT_STREAM_SILENCE_MS;
  // Set per user rather than a count: closeUser has to reach the handles, and a
  // count could drift away from reality on any path that forgot to decrement.
  const byUser = new Map<string, Set<StreamHandle>>();
  let open = 0;

  function publish(): void {
    setOpenStreams(open);
  }

  return {
    open(userId: string): StreamHandle | null {
      let handles = byUser.get(userId);
      if (handles && handles.size >= maxPerUser) return null;
      if (!handles) {
        handles = new Set<StreamHandle>();
        byUser.set(userId, handles);
      }

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;

      const handle: StreamHandle = {
        signal: controller.signal,
        touch(): void {
          if (closed) return;
          clearTimeout(timer);
          timer = setTimeout(() => handle.close(), silenceMs);
        },
        close(): void {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          handles.delete(handle);
          if (handles.size === 0) byUser.delete(userId);
          open -= 1;
          publish();
          // Last, so anything reacting to the abort already sees the
          // registration gone and cannot observe a half-closed stream.
          controller.abort();
        },
      };

      handles.add(handle);
      open += 1;
      publish();
      // Start the watchdog immediately: an upstream that accepts the connection
      // and then says nothing at all must not get an unbounded grace period
      // just because it never sent a first byte.
      handle.touch();
      return handle;
    },

    closeUser(userId: string): void {
      const handles = byUser.get(userId);
      if (!handles) return;
      // Copied first: close() mutates the set it is iterating.
      for (const handle of [...handles]) handle.close();
    },

    get size(): number {
      return open;
    },
  };
}

/**
 * The process-wide registry. See the file header for why this is a singleton.
 */
export const mailStreams: StreamRegistry = createStreamRegistry();

/**
 * Wraps the bytes flowing to the client so the registration follows the
 * stream's real life instead of the handler's.
 *
 * Every way a stream can end goes through `handle.close()`: the upstream
 * finishing or failing (`pull`), the client disconnecting (`cancel`), and the
 * handle being aborted from the outside — logout or the silence watchdog —
 * which cancels the reader so the pending `read()` settles instead of hanging.
 * Bytes are passed through untouched, so the proxied stream stays byte-for-byte
 * what Stalwart sent (the property ./contacts-harvest-stream.ts also keeps).
 */
export function guardStream(input: {
  source: ReadableStream<Uint8Array<ArrayBufferLike>>;
  handle: StreamHandle;
}): ReadableStream<Uint8Array<ArrayBufferLike>> {
  const { handle } = input;
  const reader = input.source.getReader();
  const stopReading = () => {
    void reader.cancel().catch(() => {});
  };
  if (handle.signal.aborted) stopReading();
  else handle.signal.addEventListener("abort", stopReading, { once: true });

  return new ReadableStream<Uint8Array<ArrayBufferLike>>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          handle.close();
          controller.close();
          return;
        }
        handle.touch();
        controller.enqueue(value);
      } catch (error) {
        handle.close();
        controller.error(error);
      }
    },
    cancel(reason) {
      handle.close();
      return reader.cancel(reason);
    },
  });
}
