/**
 * A tiny in-memory, per-key fixed-window rate limiter.
 *
 * This server is a single self-hosted process, so a bare Map is the whole
 * store — no Redis, no cross-process coordination. It exists to refuse a flood
 * cheaply on the unauthenticated break-glass login path (GH #183): count each
 * attempt per client IP within a fixed window and, once the window is full,
 * reject further attempts before they can do any real work (parse a body,
 * verify a password, or write an audit row).
 *
 * Fixed window rather than a sliding log or token bucket because the property
 * that matters here is simple and legible: at most `limit` attempts per
 * `windowMs` per key, with a Retry-After that plainly counts down to the next
 * reset. A sliding log would keep a timestamp per attempt for no benefit at
 * this scale.
 *
 * Time is injected (`now`, defaulting to `Date.now`) so tests drive a fake
 * clock instead of sleeping — the rest of the codebase reads `Date.now()`
 * directly (sessions.ts, mail/context.ts), and this is the same call made
 * swappable rather than a new time abstraction.
 */

export type RateLimiterOptions = {
  /** Maximum allowed attempts per key within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type RateLimiter = {
  /** Records an attempt for `key` and reports whether it is within the limit. */
  check(key: string): RateLimitResult;
  /** Drops every entry whose window has already reset. */
  prune(): void;
  /** Number of tracked keys — for observability and tests. */
  readonly size: number;
};

type Window = { count: number; resetAt: number };

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  function pruneExpired(at: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  }

  return {
    check(key: string): RateLimitResult {
      const at = now();
      // Opportunistically drop reset windows on every call so a burst of
      // distinct client IPs cannot grow the map without bound. Cheap here: the
      // key space of a single-process login endpoint is tiny.
      pruneExpired(at);

      let window = windows.get(key);
      if (!window || window.resetAt <= at) {
        window = { count: 0, resetAt: at + windowMs };
        windows.set(key, window);
      }

      if (window.count >= limit) {
        // Do not increment past the limit: a blocked flood must neither inflate
        // the counter nor push the reset out, so Retry-After keeps counting
        // down to the window that the first allowed attempt opened.
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - at) / 1000)),
        };
      }

      window.count += 1;
      return { allowed: true };
    },

    prune(): void {
      pruneExpired(now());
    },

    get size(): number {
      return windows.size;
    },
  };
}
