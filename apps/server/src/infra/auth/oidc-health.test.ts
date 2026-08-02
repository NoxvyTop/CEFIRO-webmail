import { describe, expect, it, vi } from "vitest";
import { checkOidcReachable, createOidcReadinessCheck } from "./oidc-health";

function response(status: number): Response {
  return new Response(status === 200 ? "{}" : "", { status });
}

const NEVER_ABORT = new AbortController().signal;

describe("checkOidcReachable", () => {
  it("probes the issuer's discovery document", async () => {
    const fetchFn = vi.fn(async () => response(200));
    await checkOidcReachable({ issuer: "https://idp.test", fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe(
      "https://idp.test/.well-known/openid-configuration",
    );
  });

  it("trims a trailing slash on the issuer", async () => {
    const fetchFn = vi.fn(async () => response(200));
    await checkOidcReachable({ issuer: "https://idp.test/", fetchFn: fetchFn as unknown as typeof fetch });
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe(
      "https://idp.test/.well-known/openid-configuration",
    );
  });

  it("treats any status < 500 (200, 401) as reachable", async () => {
    for (const status of [200, 401]) {
      const fetchFn = vi.fn(async () => response(status));
      expect(
        await checkOidcReachable({ issuer: "https://idp.test", fetchFn: fetchFn as unknown as typeof fetch }),
      ).toBe(true);
    }
  });

  it("treats a 5xx as unreachable (up but not serving)", async () => {
    const fetchFn = vi.fn(async () => response(503));
    expect(
      await checkOidcReachable({ issuer: "https://idp.test", fetchFn: fetchFn as unknown as typeof fetch }),
    ).toBe(false);
  });

  it("treats a transport failure as unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await checkOidcReachable({ issuer: "https://idp.test", fetchFn: fetchFn as unknown as typeof fetch }),
    ).toBe(false);
  });

  it("does not hang: a never-answering IdP resolves to unreachable via the deadline", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    expect(await checkOidcReachable({ issuer: "https://idp.test", timeoutMs: 20, fetchFn })).toBe(false);
  });

  it("threads the health probe's budget signal into the fetch (GH #242)", async () => {
    let observed: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;
    const budget = new AbortController();
    const probe = checkOidcReachable({ issuer: "https://idp.test", timeoutMs: 60_000, fetchFn, signal: budget.signal });
    budget.abort();
    expect(await probe).toBe(false);
    expect(observed?.aborted).toBe(true);
  });
});

describe("createOidcReadinessCheck", () => {
  const configured = {
    async getPublic() {
      return { issuer: "https://idp.test", clientId: "c", scopes: "openid" };
    },
  };
  const notConfigured = {
    async getPublic() {
      return null;
    },
  };

  it("reports healthy WITHOUT any outbound call when no SSO is configured", async () => {
    const fetchFn = vi.fn(async () => response(200));
    const check = createOidcReadinessCheck({
      ssoConfig: notConfigured,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await check(NEVER_ABORT)).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes the IdP and reports its reachability when SSO is configured", async () => {
    const up = vi.fn(async () => response(200));
    expect(
      await createOidcReadinessCheck({ ssoConfig: configured, fetchFn: up as unknown as typeof fetch })(NEVER_ABORT),
    ).toBe(true);

    const down = vi.fn(async () => response(503));
    expect(
      await createOidcReadinessCheck({ ssoConfig: configured, fetchFn: down as unknown as typeof fetch })(NEVER_ABORT),
    ).toBe(false);
  });

  it("reuses a healthy result for the long window — one probe per cache window, not per poll (no #194 amplification)", async () => {
    let clock = 1_000;
    const fetchFn = vi.fn(async () => response(200));
    const check = createOidcReadinessCheck({
      ssoConfig: configured,
      fetchFn: fetchFn as unknown as typeof fetch,
      okCacheMs: 60_000,
      now: () => clock,
    });
    expect(await check(NEVER_ABORT)).toBe(true);
    clock += 30_000; // still inside the healthy window
    expect(await check(NEVER_ABORT)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock += 40_000; // past the healthy window
    expect(await check(NEVER_ABORT)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("re-probes a down IdP quickly so recovery is seen within a health window", async () => {
    let clock = 1_000;
    let status = 503;
    const fetchFn = vi.fn(async () => response(status));
    const check = createOidcReadinessCheck({
      ssoConfig: configured,
      fetchFn: fetchFn as unknown as typeof fetch,
      okCacheMs: 60_000,
      downCacheMs: 5_000,
      now: () => clock,
    });
    expect(await check(NEVER_ABORT)).toBe(false);
    clock += 2_000; // inside the short down window: still cached down, no re-probe
    expect(await check(NEVER_ABORT)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock += 4_000; // past the down window
    status = 200; // the IdP recovered
    expect(await check(NEVER_ABORT)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight probe between concurrent polls", async () => {
    // The resolver is captured synchronously (the executor runs at once), so it
    // is defined even though the fetch itself only fires after each check awaits
    // its SSO config lookup.
    let resolveFetch!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchFn = vi.fn(() => gate) as unknown as typeof fetch;
    const check = createOidcReadinessCheck({ ssoConfig: configured, fetchFn });
    const a = check(NEVER_ABORT);
    const b = check(NEVER_ABORT);
    resolveFetch(response(200));
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
