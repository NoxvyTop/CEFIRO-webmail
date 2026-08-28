// #308: a client-side localStorage cache for AI summaries, layered UNDER the
// server cache (#307) and React Query's in-session cache. React Query keeps a
// generated summary only for the life of the tab, so a full reload used to drop
// the summary from the UI and force the user to click "Resumir" again — even
// though #307 made the re-request cheap, it was still a round-trip AND a manual
// click. Persisting the bullets here lets the reader re-show them on mount with
// no fetch at all.
//
// The cache MIRRORS the server's invalidation criteria (apps/server/src/modules/
// ai/router.ts): a MESSAGE summary keys by the (immutable) message id, so it can
// never go stale; a THREAD summary keys by the thread id plus a hash of its
// ordered email-id set, so a new reply produces a new key, misses, and
// regenerates rather than showing a stale conversation summary.

const PREFIX = "cefiro-ai-summary:";
// A convenience cache, not a store of record — cap the number of entries so a
// heavy user browsing many threads can't grow localStorage without bound. The
// oldest entry by write time is evicted first (each entry records its `ts`).
// This is also what reclaims a thread's orphaned old-id-set entries after it
// grows: a grown thread writes under a new key and the stale one ages out.
export const MAX_ENTRIES = 200;
const VERSION = 1;

type CachedSummary = { v: number; bullets: string[]; ts: number };

/** What a summary is keyed against, mirroring the two server cache kinds. */
export type SummaryCacheTarget = {
  isThread: boolean;
  messageId: string;
  threadId: string;
  messageCount: number;
  /**
   * The thread's email ids in chronological order (oldest→newest), when the
   * caller has them cheaply. Only consulted in thread mode.
   */
  emailIds?: string[];
};

// A short, stable, NON-cryptographic hash (FNV-1a) of the joined ids. This key
// only has to CHANGE when the id set changes — it guards a convenience cache,
// not anything security-sensitive — so the server's sha256 (node:crypto) would
// be overkill and would pull a hashing dependency into the browser bundle. The
// ids are joined in the order given (chronological, the same order the server
// hashes), so order is part of the identity.
function hashIds(orderedEmailIds: string[]): string {
  let hash = 0x811c9dc5;
  for (const char of orderedEmailIds.join("\n")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 coerces to an unsigned 32-bit int; base-36 keeps the key compact.
  return (hash >>> 0).toString(36);
}

/** The localStorage key a summary for `target` is stored under. */
export function summaryStorageKey(target: SummaryCacheTarget): string {
  if (!target.isThread) {
    // A message body is immutable, so its id IS the content key — a message
    // summary can never go stale (mirrors the server's message content key).
    return `${PREFIX}m:${target.messageId}`;
  }
  // Prefer the exact server criterion: a hash of the ordered email-id set, so a
  // new reply changes the key and misses. When the ordered id list isn't
  // available, fall back to the newest message id + the message count. Both
  // change when a reply lands, so this still invalidates on the common case (a
  // grown thread); the tradeoff is it can't detect a same-count id-set change
  // (e.g. one message deleted and another arriving between two reads), which the
  // hash would. The reader always supplies emailIds, so the fallback is only for
  // defensive/standalone callers.
  const discriminator =
    target.emailIds && target.emailIds.length > 0
      ? hashIds(target.emailIds)
      : `n:${target.messageCount}:${target.messageId}`;
  return `${PREFIX}t:${target.threadId}:${discriminator}`;
}

/** The cached bullets stored under `key`, or undefined on a miss/corrupt entry. */
export function readCachedSummary(key: string): string[] | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<CachedSummary>;
    // A version bump or a shape we don't recognize is treated as a miss rather
    // than trusted — the reader just falls back to the "Resumir" trigger.
    if (parsed.v !== VERSION || !Array.isArray(parsed.bullets)) return undefined;
    if (!parsed.bullets.every((bullet) => typeof bullet === "string")) return undefined;
    return parsed.bullets;
  } catch {
    // storage unavailable (private mode, disabled) or invalid JSON — a miss.
    return undefined;
  }
}

/** Persists `bullets` under `key`, then evicts the oldest entries past the cap. */
export function writeCachedSummary(key: string, bullets: string[]): void {
  try {
    const entry: CachedSummary = { v: VERSION, bullets, ts: Date.now() };
    localStorage.setItem(key, JSON.stringify(entry));
    evictOldestPastCap();
  } catch {
    // storage full/unavailable — the summary simply won't survive a reload;
    // never let a cache write break the render.
  }
}

/**
 * Drops every cached summary (GH #341). A React Query cache clear on
 * logout/session-expiry only reaches the in-memory layer — this localStorage
 * layer sits underneath it and survives on its own, so a fresh sign-in in the
 * same tab kept showing the previous user's AI summaries until each one aged
 * out or was overwritten.
 */
export function clearAllSummaryCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // storage unavailable (private mode, disabled) — nothing to clear.
  }
}

/** Drops the oldest-written entries once the entry count exceeds MAX_ENTRIES. */
function evictOldestPastCap(): void {
  const entries: { key: string; ts: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null || !key.startsWith(PREFIX)) continue;
    let ts = 0;
    try {
      ts = (JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<CachedSummary>).ts ?? 0;
    } catch {
      // corrupt entry — leave ts at 0 so it sorts oldest and is evicted first.
    }
    entries.push({ key, ts });
  }
  if (entries.length <= MAX_ENTRIES) return;
  entries.sort((a, b) => a.ts - b.ts);
  for (const stale of entries.slice(0, entries.length - MAX_ENTRIES)) {
    localStorage.removeItem(stale.key);
  }
}
