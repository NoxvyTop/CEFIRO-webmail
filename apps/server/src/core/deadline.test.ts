import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "./errors";
import { withDeadline, withDeadlineFetch } from "./deadline";

/** An upstream that accepts the connection and never answers — issue #165. */
function silentFetch(): typeof fetch {
  return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

/** An upstream that does honour the abort signal, as a real socket would. */
function abortAwareFetch(): typeof fetch {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (init?.signal?.aborted) {
          fail();
          return;
        }
        init?.signal?.addEventListener("abort", fail);
      }),
  ) as unknown as typeof fetch;
}

function calls(fetchFn: typeof fetch) {
  return (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("withDeadlineFetch", () => {
  it("rejects with upstream_timeout when the upstream never answers", async () => {
    vi.useFakeTimers();
    const fetchFn = silentFetch();
    const fetchWithDeadline = withDeadlineFetch(fetchFn, "stalwart", 10_000);

    const pending = fetchWithDeadline("https://mail.test/jmap");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "upstream_timeout",
      httpStatus: 504,
      messageKey: "errors.upstream_timeout",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("reports upstream_timeout — not a bare AbortError — when the upstream honours the abort", async () => {
    vi.useFakeTimers();
    const fetchFn = abortAwareFetch();
    const fetchWithDeadline = withDeadlineFetch(fetchFn, "ai", 60_000);

    const pending = fetchWithDeadline("https://api.test/v1/chat/completions");
    const assertion = expect(pending).rejects.toBeInstanceOf(DomainError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("does not fire one millisecond before the deadline", async () => {
    vi.useFakeTimers();
    const fetchWithDeadline = withDeadlineFetch(silentFetch(), "stalwart", 10_000);

    const pending = fetchWithDeadline("https://mail.test/jmap");
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(9_999);

    expect(settled).not.toHaveBeenCalled();
    // Drain the still-pending rejection so it does not surface as unhandled.
    const assertion = expect(pending).rejects.toBeInstanceOf(DomainError);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("resolves with the upstream response when it answers in time", async () => {
    const fetchFn = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const fetchWithDeadline = withDeadlineFetch(fetchFn, "stalwart", 10_000);

    const res = await fetchWithDeadline("https://mail.test/jmap");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("forwards method, headers and body untouched", async () => {
    const fetchFn = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const fetchWithDeadline = withDeadlineFetch(fetchFn, "stalwart", 10_000);

    await fetchWithDeadline("https://mail.test/jmap", {
      method: "POST",
      headers: { authorization: "Basic x", "content-type": "application/json" },
      body: '{"a":1}',
    });

    const [url, init] = calls(fetchFn)[0]!;
    expect(String(url)).toBe("https://mail.test/jmap");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Basic x");
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  describe("composition with an incoming client signal (SSE / attachment download)", () => {
    it("aborts the upstream as soon as the client goes away, before the deadline", async () => {
      vi.useFakeTimers();
      const fetchFn = abortAwareFetch();
      const fetchWithDeadline = withDeadlineFetch(fetchFn, "stalwart", 10_000);
      const client = new AbortController();

      const pending = fetchWithDeadline("https://mail.test/events", { signal: client.signal });
      const assertion = expect(pending).rejects.toThrow(/abort/i);
      client.abort();
      await assertion;

      // The client winning must not be reported as an upstream timeout.
      await expect(pending).rejects.not.toBeInstanceOf(DomainError);
      expect(calls(fetchFn)[0]![1].signal.aborted).toBe(true);
    });

    it("aborts immediately when the client signal is already aborted", async () => {
      const fetchFn = abortAwareFetch();
      const fetchWithDeadline = withDeadlineFetch(fetchFn, "stalwart", 10_000);

      await expect(
        fetchWithDeadline("https://mail.test/events", { signal: AbortSignal.abort() }),
      ).rejects.toThrow();
    });

    it("keeps aborting the upstream body when the client disconnects after the headers arrived", async () => {
      // This is the SSE case: fetch resolves as soon as the headers land and
      // the body keeps streaming for minutes. The deadline must stop counting,
      // but a later client disconnect must still tear the upstream down.
      vi.useFakeTimers();
      const fetchFn = vi.fn(async () => new Response("data: ping\n\n")) as unknown as typeof fetch;
      const fetchWithDeadline = withDeadlineFetch(fetchFn, "stalwart", 10_000);
      const client = new AbortController();

      const res = await fetchWithDeadline("https://mail.test/events", { signal: client.signal });
      const upstreamSignal = calls(fetchFn)[0]![1].signal as AbortSignal;

      // Long past the deadline, the live stream is untouched.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(res.status).toBe(200);
      expect(upstreamSignal.aborted).toBe(false);

      client.abort();
      expect(upstreamSignal.aborted).toBe(true);
    });
  });
});

describe("withDeadline", () => {
  it("rejects with upstream_timeout when the operation never settles", async () => {
    vi.useFakeTimers();

    const pending = withDeadline("ai", 60_000, () => new Promise<string>(() => {}));
    const assertion = expect(pending).rejects.toMatchObject({
      code: "upstream_timeout",
      httpStatus: 504,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("aborts the signal it hands to the operation", async () => {
    vi.useFakeTimers();
    let handed: AbortSignal | undefined;

    const pending = withDeadline("ai", 60_000, (signal) => {
      handed = signal;
      return new Promise<string>(() => {});
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(DomainError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(handed?.aborted).toBe(true);
  });

  it("resolves with the operation result when it settles in time", async () => {
    await expect(withDeadline("ai", 60_000, async () => "done")).resolves.toBe("done");
  });

  it("propagates the operation's own failure unchanged", async () => {
    await expect(
      withDeadline("ai", 60_000, async () => {
        throw new Error("provider returned garbage");
      }),
    ).rejects.toThrow("provider returned garbage");
  });
});
