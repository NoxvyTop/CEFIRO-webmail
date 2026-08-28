import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import { STREAM_STABLE_MS, retryDelayMs, useMailEvents } from "./useMailEvents";
import { NEW_MAIL_NOTICE_TAG, PERSONAL_MAILBOXES_QUERY_KEY } from "./newMailNotice";

// The first rung of the backoff ladder in useMailEvents.ts (GH #243), with
// Math.random pinned to the 0.5 the timing tests below stub in: base 2 s, half
// fixed and half jittered, so 1000 + 0.5 * 1000.
const FIXED_RANDOM = 0.5;
const FIRST_RETRY_MS = 1_500;
// Comfortably past the 60 s cap, for asserting that nothing reconnects at all.
const WELL_PAST_THE_CAP_MS = 10 * 60_000;

// Minimal EventSource stand-in: records every instance the hook opens, lets a
// test push "open"/"message"/"error" events at it, and remembers whether it was
// closed — enough to observe connect, reconnect and teardown without a network.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  // The real readyState the hook reads to tell a transport drop (the browser
  // leaves it CONNECTING) from a handshake the server refused (CLOSED).
  readyState = 0;
  private listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen() {
    this.readyState = 1;
    for (const listener of this.listeners.open ?? []) listener({});
  }

  emitMessage(data = "{}") {
    for (const listener of this.listeners.message ?? []) listener({ data });
  }

  // What the real stream actually sends. JMAP names its push frames
  // `event: state` (RFC 8887 §7.1) and the server proxies Stalwart's stream
  // through untouched, so this — not emitMessage — is the production path.
  //
  // GH #265: the hook listened only on "message", which in SSE fires just for
  // frames with NO `event:` field, so every StateChange was dropped and the
  // mailbox never updated without a manual reload. The whole suite stayed green
  // because this double only ever emitted "message": it agreed with the client
  // instead of with the server, which is exactly how a test double hides the
  // bug it was written to catch.
  emitState(data = "{}") {
    for (const listener of this.listeners.state ?? []) listener({ data });
  }

  // A transport-level drop: the browser means to retry, so readyState stays at
  // CONNECTING and the hook takes the ordinary backoff path.
  emitError() {
    for (const listener of this.listeners.error ?? []) listener({});
  }

  // The server answered and the answer was unusable (401, 502, 503…): the
  // browser has already moved the stream to CLOSED before the handler runs.
  refuseHandshake() {
    this.readyState = 2;
    this.emitError();
  }
}

function stubAuthProbe(status: number) {
  const probe = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", probe);
  return probe;
}

// Drains the microtasks the /api/auth/me probe queues, without letting any
// pending backoff timer fire.
async function flushProbe() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const clear = vi.spyOn(client, "clear");
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { invalidate, clear, wrapper };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setHidden(false);
});

describe("useMailEvents (hook lifecycle)", () => {
  it("opens no stream while disabled, then connects once enabled", () => {
    const { wrapper } = makeWrapper();
    const { rerender } = renderHook(({ enabled }) => useMailEvents(enabled), {
      wrapper,
      initialProps: { enabled: false },
    });

    expect(FakeEventSource.instances).toHaveLength(0);

    rerender({ enabled: true });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/mail/events");
  });

  // GH #342: MailPage/MessageList need to know whether live updates are
  // actually flowing right now (not just "enabled") to decide when to fall
  // back to polling — this is the one signal that answers that.
  it("exposes streamOpen: true only while a stream is actually connected", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useMailEvents(true), { wrapper });

    expect(result.current.streamOpen).toBe(false);

    act(() => FakeEventSource.instances[0]?.emitOpen());
    expect(result.current.streamOpen).toBe(true);

    act(() => FakeEventSource.instances[0]?.emitError());
    expect(result.current.streamOpen).toBe(false);
  });

  it("invalidates only the query keys the StateChange names", () => {
    const { invalidate, wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    FakeEventSource.instances[0]?.emitMessage(
      JSON.stringify({ "@type": "StateChange", changed: { acc: { Email: "s1" } } }),
    );

    const keys = invalidate.mock.calls.map(([arg]) => (arg as { queryKey: string[] }).queryKey);
    // #340: the mailbox key rides along with Email — arriving mail moves unread
    // counts, including the per-shared-account ones the sidebar reads.
    expect(keys).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
      ["mail", "mailboxes"],
    ]);
  });

  // #349: a user scrolled N pages deep into the infinite messages list used
  // to pay N sequential /api/mail/messages requests for every single
  // StateChange (GH #167 narrowed WHICH keys get invalidated; this narrows
  // the messages key's own refetch cost). TanStack Query v5 removed v4's
  // `refetchPage` predicate — `maxPages` is the only remaining primitive,
  // and it EVICTS pages beyond the cap from the query's own data, which
  // would drop already-visible rows mid-scroll the moment a user reads past
  // the cap, not just on an SSE event. Invalidating with `refetchType:
  // "none"` avoids both: nothing is evicted, nothing refetches all N pages
  // — the list just goes stale and catches up next time something already
  // triggers a refetch (window focus once past the new 30s staleTime, a
  // remount). The thread/mailboxes keys are unpaginated, so they keep the
  // normal eager refetch.
  it("marks the messages list stale WITHOUT eagerly refetching it, unlike the unpaginated thread/mailboxes keys", () => {
    const { invalidate, wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    FakeEventSource.instances[0]?.emitMessage(
      JSON.stringify({ "@type": "StateChange", changed: { acc: { Email: "s1", Mailbox: "s2" } } }),
    );

    const calls = invalidate.mock.calls.map(
      ([arg]) => arg as { queryKey: string[]; refetchType?: string },
    );
    const messagesCall = calls.find(
      (call) => call.queryKey.join(".") === "mail.messages",
    );
    const threadCall = calls.find((call) => call.queryKey.join(".") === "mail.thread");
    const mailboxesCall = calls.find((call) => call.queryKey.join(".") === "mail.mailboxes");

    expect(messagesCall?.refetchType).toBe("none");
    expect(threadCall?.refetchType).toBeUndefined();
    expect(mailboxesCall?.refetchType).toBeUndefined();
  });

  // GH #265. This is the production path: the server proxies Stalwart's stream
  // untouched and JMAP names its frames `event: state` (RFC 8887 §7.1). Before
  // the fix the hook listened only on "message" — which in SSE fires solely for
  // frames with no `event:` field — so new mail never appeared until the user
  // reloaded, while every test here passed because the double emitted the same
  // wrong name the client was listening for.
  it("invalidates on a StateChange delivered as the named `state` event, as the server really sends it", () => {
    const { invalidate, wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    FakeEventSource.instances[0]?.emitState(
      JSON.stringify({ "@type": "StateChange", changed: { acc: { Email: "s1" } } }),
    );

    const keys = invalidate.mock.calls.map(([arg]) => (arg as { queryKey: string[] }).queryKey);
    // #340: the mailbox key rides along with Email — arriving mail moves unread
    // counts, including the per-shared-account ones the sidebar reads.
    expect(keys).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
      ["mail", "mailboxes"],
    ]);
  });

  it("closes the dropped stream and reopens exactly one after the backoff delay", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });
    const first = FakeEventSource.instances[0];
    expect(first).toBeDefined();

    act(() => first?.emitError());
    expect(first?.closed).toBe(true);

    // Nothing reconnects before the delay elapses...
    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS - 1));
    expect(FakeEventSource.instances).toHaveLength(1);

    // ...and exactly one fresh stream opens once it does.
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/mail/events");
  });

  // GH #338: the alert used to fire for ANY frame carrying `Email`. It now
  // waits for the invalidation to settle and compares the personal Inbox's
  // unread count across it, so only a genuine arrival speaks.
  it("notifies only when the Inbox unread count grew, and only while hidden", async () => {
    const notify = vi.fn();
    class FakeNotification {
      static permission = "granted";
      constructor(title: string, options?: NotificationOptions) {
        notify(title, options);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);

    let unread = 1;
    const { wrapper } = makeWrapper();
    renderHook(
      () => {
        useQuery({
          queryKey: PERSONAL_MAILBOXES_QUERY_KEY,
          queryFn: async () => [{ id: "mb-inbox", role: "inbox", unreadEmails: unread }],
        });
        return useMailEvents(true);
      },
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // A change that does not move the count says nothing.
    setHidden(true);
    await act(async () => {
      FakeEventSource.instances[0]?.emitMessage();
    });
    expect(notify).not.toHaveBeenCalled();

    // An arrival does.
    unread = 4;
    await act(async () => {
      FakeEventSource.instances[0]?.emitMessage();
    });
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]?.[1]).toMatchObject({ tag: NEW_MAIL_NOTICE_TAG });
  });

  it("does not notify when notification permission was not granted", async () => {
    const notify = vi.fn();
    class FakeNotification {
      static permission = "default";
      constructor(title: string) {
        notify(title);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    setHidden(true);

    let unread = 1;
    const { wrapper } = makeWrapper();
    renderHook(
      () => {
        useQuery({
          queryKey: PERSONAL_MAILBOXES_QUERY_KEY,
          queryFn: async () => [{ id: "mb-inbox", role: "inbox", unreadEmails: unread }],
        });
        return useMailEvents(true);
      },
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    unread = 9;
    await act(async () => {
      FakeEventSource.instances[0]?.emitMessage();
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("closes the stream on unmount and cancels a pending reconnect", () => {
    vi.useFakeTimers();
    const { wrapper } = makeWrapper();
    const { unmount } = renderHook(() => useMailEvents(true), { wrapper });
    const source = FakeEventSource.instances[0];

    // A reconnect is scheduled, then the component tears down before it fires.
    act(() => source?.emitError());
    unmount();
    expect(source?.closed).toBe(true);

    // The cancelled retry must not open a new stream after unmount.
    act(() => vi.advanceTimersByTime(WELL_PAST_THE_CAP_MS));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

// GH #243: the retry was a flat 15 s with no jitter, so a server restart —
// which drops every stream in the fleet at the same instant — brought every
// client back at the same instant, against a server that had only just
// finished starting.
describe("useMailEvents reconnect backoff (GH #243)", () => {
  describe("retryDelayMs", () => {
    // Half the window fixed, half jittered: base 2 s doubling per consecutive
    // failure, capped at 60 s. The fixed half is the floor that keeps the first
    // retry from being effectively instant.
    it.each([
      [0, 1_000, 2_000],
      [1, 2_000, 4_000],
      [2, 4_000, 8_000],
      [3, 8_000, 16_000],
      [4, 16_000, 32_000],
      // Capped from here on: 2 s * 2^5 would be 64 s.
      [5, 30_000, 60_000],
      [6, 30_000, 60_000],
      [40, 30_000, 60_000],
    ])("attempt %i falls between %i ms and %i ms", (attempt, min, max) => {
      expect(retryDelayMs(attempt, 0)).toBe(min);
      expect(retryDelayMs(attempt, 1)).toBe(max);
      expect(retryDelayMs(attempt, FIXED_RANDOM)).toBe((min + max) / 2);
    });

    it("grows strictly until it reaches the cap", () => {
      const ladder = [0, 1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(attempt, FIXED_RANDOM));
      expect(ladder).toEqual([1_500, 3_000, 6_000, 12_000, 24_000, 45_000, 45_000]);
    });

    it("spreads clients that failed together across the window", () => {
      // The whole point of the jitter: identical inputs must NOT produce one
      // delay that every client in the fleet shares.
      const delays = [0, 0.2, 0.4, 0.6, 0.8, 1].map((random) => retryDelayMs(3, random));
      expect(new Set(delays).size).toBe(delays.length);
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(8_000);
        expect(delay).toBeLessThanOrEqual(16_000);
      }
    });
  });

  it("backs off exponentially across consecutive failures", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    // Each rung: the stream that just opened fails again without ever reaching
    // "open", so the next wait is the next (longer) rung.
    for (const [index, delay] of [1_500, 3_000, 6_000, 12_000].entries()) {
      const source = FakeEventSource.instances[index];
      act(() => source?.emitError());
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(FakeEventSource.instances).toHaveLength(index + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(FakeEventSource.instances).toHaveLength(index + 2);
    }
  });

  // GH #342: an "open" that immediately drops again used to reset `attempt`
  // to 0 unconditionally — exactly what happens when a proxy accepts the SSE
  // handshake and then cuts it (proxy_read_timeout, an upstream that closes
  // after headers). That turned the backoff ladder into a flat ~1s retry
  // loop, each attempt also paying for the classifyRefusedHandshake probe. A
  // reset now requires the stream to have stayed open for the stability
  // window (below), or to have delivered at least one data frame.
  it("restarts the ladder from the bottom once a stream has stayed open long enough to be trusted", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    // Two failures in a row put the next wait on the second rung.
    act(() => FakeEventSource.instances[0]?.emitError());
    act(() => vi.advanceTimersByTime(1_500));
    act(() => FakeEventSource.instances[1]?.emitError());
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.instances).toHaveLength(3);

    // The third stream opens and STAYS open past the stability window,
    // proving the server is serving again, so the next outage waits the
    // FIRST rung rather than the third.
    act(() => FakeEventSource.instances[2]?.emitOpen());
    act(() => vi.advanceTimersByTime(STREAM_STABLE_MS));
    act(() => FakeEventSource.instances[2]?.emitError());
    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS - 1));
    expect(FakeEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("does NOT reset the backoff for a stream that opens and drops again before the stability window elapses (GH #342)", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    act(() => FakeEventSource.instances[0]?.emitError());
    act(() => vi.advanceTimersByTime(1_500));
    act(() => FakeEventSource.instances[1]?.emitError());
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.instances).toHaveLength(3);

    // Accepted, then cut almost immediately — an intermediary closing the
    // handshake, not proof the server has recovered.
    act(() => FakeEventSource.instances[2]?.emitOpen());
    act(() => vi.advanceTimersByTime(STREAM_STABLE_MS - 1));
    act(() => FakeEventSource.instances[2]?.emitError());

    // If attempt had reset to 0, the next stream would appear after
    // FIRST_RETRY_MS (1_500ms). It must not: the ladder continues from the
    // third rung (6_000ms) instead.
    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS));
    expect(FakeEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(6_000 - FIRST_RETRY_MS - 1));
    expect(FakeEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("resets the backoff as soon as the first data frame arrives, without waiting for the full stability window (GH #342)", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    act(() => FakeEventSource.instances[0]?.emitError());
    act(() => vi.advanceTimersByTime(1_500));
    act(() => FakeEventSource.instances[1]?.emitError());
    act(() => vi.advanceTimersByTime(3_000));

    act(() => FakeEventSource.instances[2]?.emitOpen());
    act(() =>
      FakeEventSource.instances[2]?.emitState(
        JSON.stringify({ "@type": "StateChange", changed: {} }),
      ),
    );
    act(() => FakeEventSource.instances[2]?.emitError());

    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS - 1));
    expect(FakeEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("stops reconnecting for good once the events endpoint answers 401 (session gone)", async () => {
    vi.useFakeTimers();
    const probe = stubAuthProbe(401);
    const { clear, wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    act(() => FakeEventSource.instances[0]?.refuseHandshake());
    await flushProbe();

    // GH #274: the probe now re-asks the events endpoint itself — the only
    // thing that can tell a 401 (session) from a 429 (stream cap) apart — not
    // /api/auth/me, which cannot see the cap.
    expect(probe).toHaveBeenCalledWith(
      "/api/mail/events",
      expect.objectContaining({ signal: expect.anything() }),
    );
    // No amount of waiting reopens the stream: only a fresh login can.
    act(() => vi.advanceTimersByTime(WELL_PAST_THE_CAP_MS));
    expect(FakeEventSource.instances).toHaveLength(1);
    // GH #341: the whole cache is dropped, not just ["auth","me"] — otherwise
    // a mailbox/thread/profile query from the expired session stays cached and
    // can flash stale content before RequireAuth routes to the login screen.
    expect(clear).toHaveBeenCalledTimes(1);
  });

  // GH #274: a second tab over the 8/user cap gets 429 too_many_streams. That
  // closes the stream exactly like a 401 does, but the session is fine — the
  // old code probed /api/auth/me, saw !=401, and retried forever in silence, so
  // the tab never went live and never said why. It must now stop and surface it.
  it("distinguishes a 429 too_many_streams: stops retrying and reports live updates limited, leaving the session alone", async () => {
    vi.useFakeTimers();
    const probe = stubAuthProbe(429);
    const { clear, wrapper } = makeWrapper();
    const { result } = renderHook(() => useMailEvents(true), { wrapper });

    expect(result.current.liveUpdatesLimited).toBe(false);

    act(() => FakeEventSource.instances[0]?.refuseHandshake());
    await flushProbe();

    // It asked the events endpoint — the only place that knows about the cap.
    expect(probe).toHaveBeenCalledWith(
      "/api/mail/events",
      expect.objectContaining({ signal: expect.anything() }),
    );
    // The tab is flagged limited so the UI can say so...
    expect(result.current.liveUpdatesLimited).toBe(true);
    // ...the session is left untouched (this is not a 401)...
    expect(clear).not.toHaveBeenCalled();
    // ...and it never silently reconnects again.
    act(() => vi.advanceTimersByTime(WELL_PAST_THE_CAP_MS));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("keeps retrying when the handshake was refused but the session is still good", async () => {
    // A 502/503 from a server still coming back up closes the stream exactly
    // like a 401 does — and giving up on those is the restart this backoff
    // exists to survive.
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    stubAuthProbe(200);
    const { invalidate, wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    act(() => FakeEventSource.instances[0]?.refuseHandshake());
    await flushProbe();

    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["auth", "me"] });
  });

  it("keeps retrying when the session probe itself cannot be made", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    act(() => FakeEventSource.instances[0]?.refuseHandshake());
    await flushProbe();

    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  // GH #342: the probe is a second request on top of the EventSource itself.
  // While the browser is offline it cannot possibly tell 401 from 429 from
  // "server restarting" — it will just fail too — so it is skipped, and the
  // refusal is treated as transient (ordinary backoff, no probe cost).
  it("skips the session probe while the browser is offline and treats the refusal as transient", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    const probe = stubAuthProbe(200);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    act(() => FakeEventSource.instances[0]?.refuseHandshake());
    await flushProbe();

    expect(probe).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("does not probe the session for an ordinary transport drop", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
    const probe = stubAuthProbe(401);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    // readyState stays at CONNECTING: the browser dropped the socket and means
    // to retry, so there is nothing to ask /api/auth/me about.
    act(() => FakeEventSource.instances[0]?.emitError());
    await flushProbe();

    expect(probe).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(FIRST_RETRY_MS));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("does not reconnect after unmount even if the session probe resolves late", async () => {
    vi.useFakeTimers();
    stubAuthProbe(200);
    const { wrapper } = makeWrapper();
    const { unmount } = renderHook(() => useMailEvents(true), { wrapper });

    act(() => FakeEventSource.instances[0]?.refuseHandshake());
    unmount();
    await flushProbe();

    act(() => vi.advanceTimersByTime(WELL_PAST_THE_CAP_MS));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
