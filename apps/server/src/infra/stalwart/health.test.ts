import { describe, expect, it, vi } from "vitest";
import { checkStalwart } from "./health";

function response(status: number): Response {
  return new Response(status === 200 ? "{}" : "", { status });
}

describe("checkStalwart", () => {
  it("probes the JMAP session well-known path on the configured base URL", async () => {
    const fetchFn = vi.fn(async () => response(401));
    await checkStalwart({ url: "https://mail.test", fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchFn.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toBe("https://mail.test/.well-known/jmap");
  });

  it("treats a 401 (reachable but unauthenticated) as healthy", async () => {
    const fetchFn = vi.fn(async () => response(401));
    expect(
      await checkStalwart({ url: "https://mail.test", fetchFn: fetchFn as unknown as typeof fetch }),
    ).toBe(true);
  });

  it("treats a 200 as healthy", async () => {
    const fetchFn = vi.fn(async () => response(200));
    expect(
      await checkStalwart({ url: "https://mail.test", fetchFn: fetchFn as unknown as typeof fetch }),
    ).toBe(true);
  });

  it("treats a 5xx as unhealthy (up but not serving)", async () => {
    const fetchFn = vi.fn(async () => response(503));
    expect(
      await checkStalwart({ url: "https://mail.test", fetchFn: fetchFn as unknown as typeof fetch }),
    ).toBe(false);
  });

  it("treats a transport failure as unhealthy", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await checkStalwart({ url: "https://mail.test", fetchFn: fetchFn as unknown as typeof fetch }),
    ).toBe(false);
  });

  it("does not hang: a never-answering Stalwart resolves to unhealthy via the deadline", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    expect(await checkStalwart({ url: "https://mail.test", timeoutMs: 20, fetchFn })).toBe(false);
  });

  // GH #242: the probe's budget (2s) is an order of magnitude tighter than this
  // dependency's own deadline (~10s), and before this the fetch never learned
  // the probe had given up — so a cold-cache poll left seconds of outbound work
  // running behind an answer that had already been sent.
  it("aborts the fetch when the health probe's budget runs out", async () => {
    let observed: AbortSignal | undefined;
    // Rejects on abort, the way a real fetch does — which is the whole point:
    // without the signal reaching it, this request had nothing to reject on.
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }) as unknown as typeof fetch;
    const budget = new AbortController();

    const probe = checkStalwart({
      url: "https://mail.test",
      timeoutMs: 60_000,
      fetchFn,
      signal: budget.signal,
    });
    budget.abort();

    // Unhealthy well inside the 60s outbound deadline, because the budget — not
    // the deadline — is what ended it.
    expect(await probe).toBe(false);
    expect(observed?.aborted).toBe(true);
  });

  it("trims a trailing slash on the base URL", async () => {
    const fetchFn = vi.fn(async () => response(401));
    await checkStalwart({ url: "https://mail.test/", fetchFn: fetchFn as unknown as typeof fetch });
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe("https://mail.test/.well-known/jmap");
  });
});
