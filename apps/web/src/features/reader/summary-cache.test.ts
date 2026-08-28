import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ENTRIES, clearAllSummaryCache, readCachedSummary, summaryStorageKey, writeCachedSummary,
} from "./summaryCache";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summaryStorageKey", () => {
  it("keys a message summary by its immutable id, regardless of thread", () => {
    const a = summaryStorageKey({ isThread: false, messageId: "e1", threadId: "t1", messageCount: 1 });
    const b = summaryStorageKey({ isThread: false, messageId: "e1", threadId: "t9", messageCount: 1 });
    expect(a).toBe(b);
    // A different message id is a different key.
    const c = summaryStorageKey({ isThread: false, messageId: "e2", threadId: "t1", messageCount: 1 });
    expect(c).not.toBe(a);
  });

  it("changes the thread key when the ordered id set grows (a new reply)", () => {
    const before = summaryStorageKey({
      isThread: true, threadId: "t1", messageId: "e2", messageCount: 2, emailIds: ["e1", "e2"],
    });
    const after = summaryStorageKey({
      isThread: true, threadId: "t1", messageId: "e3", messageCount: 3, emailIds: ["e1", "e2", "e3"],
    });
    expect(after).not.toBe(before);
  });

  it("keeps the thread key stable for the same id set, but not a reordering", () => {
    const one = summaryStorageKey({
      isThread: true, threadId: "t1", messageId: "e2", messageCount: 2, emailIds: ["e1", "e2"],
    });
    const two = summaryStorageKey({
      isThread: true, threadId: "t1", messageId: "e2", messageCount: 2, emailIds: ["e1", "e2"],
    });
    expect(one).toBe(two);
    // Order is part of the identity (matches the server, which hashes the
    // chronological join).
    const reordered = summaryStorageKey({
      isThread: true, threadId: "t1", messageId: "e2", messageCount: 2, emailIds: ["e2", "e1"],
    });
    expect(reordered).not.toBe(one);
  });

  it("falls back to count + newest id when no id list is available", () => {
    const two = summaryStorageKey({ isThread: true, threadId: "t1", messageId: "e2", messageCount: 2 });
    const three = summaryStorageKey({ isThread: true, threadId: "t1", messageId: "e3", messageCount: 3 });
    expect(three).not.toBe(two);
  });
});

describe("read/write round-trip", () => {
  it("returns the bullets written under a key", () => {
    const key = summaryStorageKey({ isThread: false, messageId: "e1", threadId: "t1", messageCount: 1 });
    writeCachedSummary(key, ["one", "two"]);
    expect(readCachedSummary(key)).toEqual(["one", "two"]);
  });

  it("returns undefined for a missing key", () => {
    expect(readCachedSummary("cefiro-ai-summary:m:absent")).toBeUndefined();
  });

  it("treats a non-JSON entry as a miss", () => {
    const key = summaryStorageKey({ isThread: false, messageId: "e1", threadId: "t1", messageCount: 1 });
    localStorage.setItem(key, "{not json");
    expect(readCachedSummary(key)).toBeUndefined();
  });

  it("treats an entry from an older cache version as a miss", () => {
    const key = summaryStorageKey({ isThread: false, messageId: "e1", threadId: "t1", messageCount: 1 });
    localStorage.setItem(key, JSON.stringify({ v: 0, bullets: ["stale"], ts: 1 }));
    expect(readCachedSummary(key)).toBeUndefined();
  });

  it("treats a non-array/wrong-shape payload as a miss", () => {
    const key = summaryStorageKey({ isThread: false, messageId: "e1", threadId: "t1", messageCount: 1 });
    localStorage.setItem(key, JSON.stringify({ v: 1, bullets: "not-an-array", ts: 1 }));
    expect(readCachedSummary(key)).toBeUndefined();
  });
});

// GH #341: a fresh sign-in in the same tab must not keep showing the previous
// user's AI summaries. The other half of the fix (React Query) clears request
// caches; this clears the localStorage layer that sits UNDER React Query and
// survives a query-cache clear on its own.
describe("clearAllSummaryCache (GH #341)", () => {
  it("removes every cefiro-ai-summary: entry", () => {
    writeCachedSummary("cefiro-ai-summary:m:e1", ["one"]);
    writeCachedSummary("cefiro-ai-summary:t:t1:abc", ["two"]);

    clearAllSummaryCache();

    expect(readCachedSummary("cefiro-ai-summary:m:e1")).toBeUndefined();
    expect(readCachedSummary("cefiro-ai-summary:t:t1:abc")).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it("leaves unrelated localStorage keys untouched", () => {
    localStorage.setItem("cefiro-theme", "night");
    writeCachedSummary("cefiro-ai-summary:m:e1", ["one"]);

    clearAllSummaryCache();

    expect(localStorage.getItem("cefiro-theme")).toBe("night");
  });

  it("does nothing when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      get length(): number {
        throw new Error("unavailable");
      },
    });
    try {
      expect(() => clearAllSummaryCache()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("eviction", () => {
  it("caps the number of stored entries, evicting the oldest-written first", () => {
    // A monotonic clock so write order is unambiguous (Date.now()'s ms
    // resolution would tie in a tight loop, making "oldest" non-deterministic).
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));

    const overflow = 5;
    for (let i = 0; i < MAX_ENTRIES + overflow; i++) {
      writeCachedSummary(`cefiro-ai-summary:m:e${i}`, [`s${i}`]);
    }

    // The first `overflow` writes are gone; the newest survives.
    expect(readCachedSummary("cefiro-ai-summary:m:e0")).toBeUndefined();
    expect(readCachedSummary(`cefiro-ai-summary:m:e${MAX_ENTRIES + overflow - 1}`)).toEqual([
      `s${MAX_ENTRIES + overflow - 1}`,
    ]);
  });
});
