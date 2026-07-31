import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import { useMailEvents } from "./useMailEvents";

// Must match RETRY_DELAY_MS in useMailEvents.ts — the backoff before a dropped
// stream is reopened.
const RETRY_DELAY_MS = 15_000;

// Minimal EventSource stand-in: records every instance the hook opens, lets a
// test push "message"/"error" events at it, and remembers whether it was
// closed — enough to observe connect, reconnect and teardown without a network.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
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
  }

  emitMessage(data = "{}") {
    for (const listener of this.listeners.message ?? []) listener({ data });
  }

  emitError() {
    for (const listener of this.listeners.error ?? []) listener({});
  }
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { invalidate, wrapper };
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

  it("invalidates only the query keys the StateChange names", () => {
    const { invalidate, wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    FakeEventSource.instances[0]?.emitMessage(
      JSON.stringify({ "@type": "StateChange", changed: { acc: { Email: "s1" } } }),
    );

    const keys = invalidate.mock.calls.map(([arg]) => (arg as { queryKey: string[] }).queryKey);
    expect(keys).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
    ]);
  });

  it("closes the dropped stream and reopens exactly one after the backoff delay", () => {
    vi.useFakeTimers();
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });
    const first = FakeEventSource.instances[0];
    expect(first).toBeDefined();

    act(() => first?.emitError());
    expect(first?.closed).toBe(true);

    // Nothing reconnects before the delay elapses...
    act(() => vi.advanceTimersByTime(RETRY_DELAY_MS - 1));
    expect(FakeEventSource.instances).toHaveLength(1);

    // ...and exactly one fresh stream opens once it does.
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/mail/events");
  });

  it("notifies once per message only when the tab is hidden and permission is granted", () => {
    const notify = vi.fn();
    class FakeNotification {
      static permission = "granted";
      constructor(title: string) {
        notify(title);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    // Visible tab: a message must not raise a notification.
    setHidden(false);
    FakeEventSource.instances[0]?.emitMessage();
    expect(notify).not.toHaveBeenCalled();

    // Hidden tab: one notification per arriving message.
    setHidden(true);
    FakeEventSource.instances[0]?.emitMessage();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify when notification permission was not granted", () => {
    const notify = vi.fn();
    class FakeNotification {
      static permission = "default";
      constructor(title: string) {
        notify(title);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    setHidden(true);
    const { wrapper } = makeWrapper();
    renderHook(() => useMailEvents(true), { wrapper });

    FakeEventSource.instances[0]?.emitMessage();

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
    act(() => vi.advanceTimersByTime(RETRY_DELAY_MS * 2));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
