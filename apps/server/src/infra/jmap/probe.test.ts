import { afterEach, describe, expect, it, vi } from "vitest";
import { probeJmap } from "./probe";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

const sessionBody = {
  apiUrl: "https://internal.mail.test:8080/jmap/",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
};

describe("probeJmap (GH #188)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hits the discovery endpoint on the configured base URL, without credentials", async () => {
    const fetchFn = fetchReturning({}, 401);
    await probeJmap({
      url: "https://mail.test/",
      urlMode: "rewrite",
      authMode: "basic",
      fetchFn,
    });
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe("https://mail.test/.well-known/jmap");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("treats a 401 as reachable — discovery needs credentials the probe does not send", async () => {
    const result = await probeJmap({
      url: "https://mail.test",
      urlMode: "rewrite",
      authMode: "basic",
      fetchFn: fetchReturning({}, 401),
    });
    expect(result).toMatchObject({ outcome: "reachable", status: 401 });
  });

  it("reports a 5xx as up-but-not-serving", async () => {
    const result = await probeJmap({
      url: "https://mail.test",
      urlMode: "rewrite",
      authMode: "basic",
      fetchFn: fetchReturning({}, 503),
    });
    expect(result).toMatchObject({ outcome: "not-serving", status: 503 });
  });

  it("reports a refused connection as unreachable instead of throwing", async () => {
    const result = await probeJmap({
      url: "https://mail.test",
      urlMode: "rewrite",
      authMode: "basic",
      fetchFn: vi.fn(async () => {
        throw new TypeError("connection refused");
      }) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("unreachable");
    expect(result.error).toContain("connection refused");
  });

  it("reports the outbound deadline expiring as unreachable", async () => {
    vi.useFakeTimers();
    const pending = probeJmap({
      url: "https://mail.test",
      urlMode: "rewrite",
      authMode: "basic",
      timeoutMs: 50,
      fetchFn: vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(51);
    expect((await pending).outcome).toBe("unreachable");
  });

  it("shows advertised and resolved apiUrl side by side when a session comes back", async () => {
    const result = await probeJmap({
      url: "https://mail.test",
      urlMode: "rewrite",
      authMode: "basic",
      fetchFn: fetchReturning(sessionBody),
    });
    expect(result.advertisedApiUrl).toBe("https://internal.mail.test:8080/jmap/");
    expect(result.resolvedApiUrl).toBe("https://mail.test/jmap/");
  });

  it("shows the advertised URL unchanged in trust mode", async () => {
    const result = await probeJmap({
      url: "https://mail.test",
      urlMode: "trust",
      authMode: "basic",
      fetchFn: fetchReturning(sessionBody),
    });
    expect(result.resolvedApiUrl).toBe("https://internal.mail.test:8080/jmap/");
  });

  it("stays reachable when the body is not JSON", async () => {
    const result = await probeJmap({
      url: "https://mail.test",
      urlMode: "rewrite",
      authMode: "basic",
      fetchFn: fetchReturning("<html>hello</html>"),
    });
    expect(result).toMatchObject({ outcome: "reachable", status: 200 });
    expect(result.advertisedApiUrl).toBeUndefined();
  });

  it("stays reachable when the JSON carries no apiUrl", async () => {
    const result = await probeJmap({
      url: "https://mail.test",
      urlMode: "rewrite",
      authMode: "basic",
      fetchFn: fetchReturning({ apiUrl: "" }),
    });
    expect(result.outcome).toBe("reachable");
    expect(result.advertisedApiUrl).toBeUndefined();
  });
});
