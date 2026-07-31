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

  it("trims a trailing slash on the base URL", async () => {
    const fetchFn = vi.fn(async () => response(401));
    await checkStalwart({ url: "https://mail.test/", fetchFn: fetchFn as unknown as typeof fetch });
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe("https://mail.test/.well-known/jmap");
  });
});
