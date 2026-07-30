import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit and blocks the next attempt in the same window", () => {
    let now = 1_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });

    for (let i = 0; i < 3; i++) {
      expect(limiter.check("ip-a").allowed).toBe(true);
    }
    const blocked = limiter.check("ip-a");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("reports a Retry-After that counts down to the window reset", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    expect(limiter.check("ip").allowed).toBe(true); // window opens at 0, resets at 60_000
    now = 20_000;
    const result = limiter.check("ip");
    expect(result.allowed).toBe(false);
    // ceil((60_000 - 20_000) / 1000) === 40
    if (!result.allowed) expect(result.retryAfterSeconds).toBe(40);
  });

  it("resets the window once the interval has elapsed", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });

    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(false);

    now = 60_000; // window boundary reached -> counter resets
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("keeps counters isolated per key", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    expect(limiter.check("ip-a").allowed).toBe(true);
    expect(limiter.check("ip-a").allowed).toBe(false);
    // A different key has its own budget and is unaffected.
    expect(limiter.check("ip-b").allowed).toBe(true);
  });

  it("prunes entries whose window has expired so the map does not grow unbounded", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, now: () => now });

    limiter.check("ip-a");
    limiter.check("ip-b");
    limiter.check("ip-c");
    expect(limiter.size).toBe(3);

    now = 60_000; // every window has reset
    limiter.prune();
    expect(limiter.size).toBe(0);
  });

  it("does not let blocked attempts grow the counter without bound", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    expect(limiter.check("ip").allowed).toBe(true);
    // A flood of blocked attempts must not extend or inflate the window: the
    // Retry-After keeps counting down toward the original reset, never resets.
    now = 30_000;
    for (let i = 0; i < 100; i++) limiter.check("ip");
    now = 59_999;
    const result = limiter.check("ip");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.retryAfterSeconds).toBe(1);
  });
});
