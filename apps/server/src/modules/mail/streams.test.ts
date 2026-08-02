import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamRegistry,
  DEFAULT_MAX_STREAMS_PER_USER,
  DEFAULT_STREAM_SILENCE_MS,
  guardStream,
  mailStreams,
} from "./streams";
import { evictMailSession } from "./context";

// GH #241. `GET /api/mail/events` clears Bun's idle timeout for its socket
// (correct — GH #204), which left it as the one route in this server with no
// deadline, no ceiling and no bookkeeping. These pin the three things that were
// missing: a per-user cap, a silence deadline this process owns, and streams
// that actually stop when the session does.

afterEach(() => {
  vi.useRealTimers();
});

/** A source that never produces anything, like a socket held open in silence. */
function silentSource(): ReadableStream<Uint8Array<ArrayBufferLike>> {
  return new ReadableStream({ start() {} });
}

function chunk(text: string): Uint8Array<ArrayBufferLike> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBufferLike>;
}

describe("per-user stream cap", () => {
  it("refuses the stream past the cap and keeps the ones already open", () => {
    const registry = createStreamRegistry({ maxPerUser: 2 });

    const first = registry.open("u1");
    const second = registry.open("u1");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    expect(registry.open("u1")).toBeNull();
    // Refusing the NEWEST rather than evicting the oldest: an EventSource whose
    // connection the server closes reconnects at once, so evicting would turn
    // one client over the cap into a permanent reconnect storm.
    expect(first!.signal.aborted).toBe(false);
    expect(registry.size).toBe(2);
  });

  it("caps each user separately", () => {
    const registry = createStreamRegistry({ maxPerUser: 1 });
    expect(registry.open("u1")).not.toBeNull();
    expect(registry.open("u1")).toBeNull();
    // One user at their ceiling must not spend anyone else's budget.
    expect(registry.open("u2")).not.toBeNull();
  });

  it("frees the slot when a stream closes", () => {
    const registry = createStreamRegistry({ maxPerUser: 1 });
    const handle = registry.open("u1")!;
    expect(registry.open("u1")).toBeNull();

    handle.close();
    expect(registry.size).toBe(0);
    expect(registry.open("u1")).not.toBeNull();
  });

  it("closes idempotently, so the count cannot drift below zero", () => {
    const registry = createStreamRegistry({ maxPerUser: 2 });
    const handle = registry.open("u1")!;
    handle.close();
    handle.close();
    handle.close();
    expect(registry.size).toBe(0);
  });
});

describe("silence watchdog", () => {
  it("closes a stream whose upstream has gone quiet", () => {
    vi.useFakeTimers();
    const registry = createStreamRegistry({ silenceMs: 1_000 });
    const handle = registry.open("u1")!;

    vi.advanceTimersByTime(999);
    expect(handle.signal.aborted).toBe(false);

    // The failure this exists for: Stalwart holding the socket open and saying
    // nothing. Nothing else was watching once the idle timeout was cleared.
    vi.advanceTimersByTime(1);
    expect(handle.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("restarts the deadline on every byte received", () => {
    vi.useFakeTimers();
    const registry = createStreamRegistry({ silenceMs: 1_000 });
    const handle = registry.open("u1")!;

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(900);
      handle.touch();
    }
    // 4.5s of a healthy 30s-ping stream must not have tripped a 1s watchdog.
    expect(handle.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(handle.signal.aborted).toBe(true);
  });

  it("starts counting before the first byte", () => {
    // An upstream that accepts the connection and never sends anything at all
    // must not get an unbounded grace period.
    vi.useFakeTimers();
    const registry = createStreamRegistry({ silenceMs: 1_000 });
    const handle = registry.open("u1")!;
    vi.advanceTimersByTime(1_000);
    expect(handle.signal.aborted).toBe(true);
  });

  it("allows three missed pings by default", () => {
    // The route asks Stalwart for {ping}=30, so this is the smallest budget
    // that cannot mistake one dropped keepalive for a dead upstream.
    expect(DEFAULT_STREAM_SILENCE_MS).toBe(3 * 30_000);
  });
});

describe("guardStream", () => {
  it("passes bytes through untouched and releases when the source ends", async () => {
    const registry = createStreamRegistry();
    const handle = registry.open("u1")!;
    const source = new ReadableStream<Uint8Array<ArrayBufferLike>>({
      start(controller) {
        controller.enqueue(chunk("event: state\n"));
        controller.enqueue(chunk("data: {}\n\n"));
        controller.close();
      },
    });

    const out = guardStream({ source, handle });
    const text = await new Response(out).text();

    expect(text).toBe("event: state\ndata: {}\n\n");
    expect(registry.size).toBe(0);
  });

  it("releases when the client disconnects", async () => {
    const registry = createStreamRegistry();
    const handle = registry.open("u1")!;
    const out = guardStream({ source: silentSource(), handle });

    await out.cancel();

    expect(registry.size).toBe(0);
    // The registration going away is not enough: the abort is what tears the
    // upstream Stalwart connection down rather than abandoning it.
    expect(handle.signal.aborted).toBe(true);
  });

  it("ends the stream when the handle is aborted from outside", async () => {
    const registry = createStreamRegistry();
    const handle = registry.open("u1")!;
    const out = guardStream({ source: silentSource(), handle });
    const reader = out.getReader();
    const pending = reader.read();

    handle.close();

    // A pending read has to settle rather than hang forever, or "close the
    // stream at logout" would only ever close it on paper.
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("releases when the source fails", async () => {
    const registry = createStreamRegistry();
    const handle = registry.open("u1")!;
    const source = new ReadableStream<Uint8Array<ArrayBufferLike>>({
      start(controller) {
        controller.error(new Error("upstream reset"));
      },
    });

    const out = guardStream({ source, handle });
    await expect(new Response(out).text()).rejects.toThrow();
    expect(registry.size).toBe(0);
  });
});

describe("evictMailSession closes in-flight streams (GH #241)", () => {
  it("aborts every stream the user has open", () => {
    // Before this, evicting a session dropped the cached JMAP session and
    // nothing else — so a stream opened before logout kept delivering that
    // mailbox's events afterwards, on credentials that had been revoked.
    const first = mailStreams.open("evicted-user")!;
    const second = mailStreams.open("evicted-user")!;
    const other = mailStreams.open("other-user")!;

    evictMailSession("evicted-user");

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);

    other.close();
  });
});

describe("defaults", () => {
  it("leaves room for a user with several tabs of their own mailbox", () => {
    expect(DEFAULT_MAX_STREAMS_PER_USER).toBe(8);
  });
});
