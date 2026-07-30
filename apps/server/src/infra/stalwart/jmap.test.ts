import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STALWART_TIMEOUT_MS } from "../../core/deadline";
import { createJmapClient, type JmapSession } from "./jmap";

const auth = { email: "u@noxvytop.com", password: "mailbox-pw" };
const sessionBody = {
  apiUrl: "https://mail.test/jmap/",
  eventSourceUrl: "https://mail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
  uploadUrl: "https://mail.test/jmap/upload/{accountId}/",
  downloadUrl: "https://mail.test/jmap/download/{accountId}/{blobId}/{name}?type={type}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
};

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("jmap client", () => {
  it("fetches the session with basic auth and maps fields", async () => {
    const fetchFn = fetchReturning(sessionBody);
    const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
    const session = await client.getSession(auth);
    expect(session.accountId).toBe("acc-1");
    expect(session.apiUrl).toBe("https://mail.test/jmap/");
    expect(session.uploadUrl).toBe("https://mail.test/jmap/upload/{accountId}/");
    expect(session.downloadUrl).toBe(
      "https://mail.test/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    );
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe("https://mail.test/.well-known/jmap");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa("u@noxvytop.com:mailbox-pw")}`,
    );
  });

  const advertisedElsewhere = {
    apiUrl: "https://internal.mail.test:8080/jmap/",
    eventSourceUrl:
      "https://internal.mail.test:8080/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
    uploadUrl: "https://internal.mail.test:8080/jmap/upload/{accountId}/",
    downloadUrl:
      "https://internal.mail.test:8080/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
  };

  it("trusts the server-advertised origin verbatim when forceBase is off (default)", async () => {
    const client = createJmapClient({
      baseUrl: "https://mail.test",
      fetchFn: fetchReturning(advertisedElsewhere),
    });
    const session = await client.getSession(auth);
    expect(session.apiUrl).toBe("https://internal.mail.test:8080/jmap/");
    expect(session.uploadUrl).toBe(
      "https://internal.mail.test:8080/jmap/upload/{accountId}/",
    );
  });

  it("rewrites advertised URLs to the connection origin when forceBase is on, keeping path and query", async () => {
    const fetchFn = fetchReturning(advertisedElsewhere);
    const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn, forceBase: true });
    const session = await client.getSession(auth);
    expect(session.apiUrl).toBe("https://mail.test/jmap/");
    expect(session.uploadUrl).toBe("https://mail.test/jmap/upload/{accountId}/");
    expect(session.downloadUrl).toBe(
      "https://mail.test/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    );
    expect(session.eventSourceUrl).toBe(
      "https://mail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
    );
  });

  it("maps 401 to mail_auth_failed", async () => {
    const client = createJmapClient({
      baseUrl: "https://mail.test",
      fetchFn: fetchReturning({}, 401),
    });
    await expect(client.getSession(auth)).rejects.toMatchObject({
      code: "mail_auth_failed",
    });
  });

  it("posts method calls and returns methodResponses", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ methodResponses: [["Mailbox/get", { list: [] }, "0"]] }),
      ),
    ) as unknown as typeof fetch;
    const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    };
    const responses = await client.request(auth, session, [
      ["Mailbox/get", { accountId: "acc-1" }, "0"],
    ]);
    expect(responses[0]?.[0]).toBe("Mailbox/get");
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.using).toContain("urn:ietf:params:jmap:mail");
    expect(body.using).toContain("urn:ietf:params:jmap:submission");
    expect(body.methodCalls[0][0]).toBe("Mailbox/get");
  });

  it("maps a jmap error response tuple to jmap_error", async () => {
    const client = createJmapClient({
      baseUrl: "https://mail.test",
      fetchFn: fetchReturning({
        methodResponses: [["error", { type: "serverFail" }, "0"]],
      }),
    });
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    };
    await expect(
      client.request(auth, session, [["Mailbox/get", {}, "0"]]),
    ).rejects.toMatchObject({ code: "jmap_error" });
  });

  describe("outbound deadline (GH #165)", () => {
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    };

    /** Stalwart accepts the connection and then never answers. */
    function silentFetch(): typeof fetch {
      return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails getSession with upstream_timeout when Stalwart never answers", async () => {
      vi.useFakeTimers();
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: silentFetch() });

      const pending = client.getSession(auth);
      const assertion = expect(pending).rejects.toMatchObject({
        code: "upstream_timeout",
        httpStatus: 504,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_STALWART_TIMEOUT_MS);
      await assertion;
    });

    it("fails request with upstream_timeout when Stalwart never answers", async () => {
      vi.useFakeTimers();
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: silentFetch() });

      const pending = client.request(auth, session, [["Mailbox/get", {}, "0"]]);
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_STALWART_TIMEOUT_MS);
      await assertion;
    });

    it("fails uploadBlob with upstream_timeout when Stalwart never answers", async () => {
      vi.useFakeTimers();
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: silentFetch() });

      const pending = client.uploadBlob(auth, session, "script", "application/sieve");
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_STALWART_TIMEOUT_MS);
      await assertion;
    });

    it("honours a configured timeoutMs instead of the default", async () => {
      vi.useFakeTimers();
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: silentFetch(),
        timeoutMs: 2_000,
      });

      const pending = client.getSession(auth);
      const settled = vi.fn();
      pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).not.toHaveBeenCalled();

      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    });

    it("leaves a response that arrives in time completely untouched", async () => {
      vi.useFakeTimers();
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: fetchReturning(sessionBody),
      });

      const result = await client.getSession(auth);

      expect(result.accountId).toBe("acc-1");
      // Well past the deadline: a settled call must never be timed out later.
      await vi.advanceTimersByTimeAsync(DEFAULT_STALWART_TIMEOUT_MS * 10);
      expect(result.apiUrl).toBe("https://mail.test/jmap/");
    });
  });

  describe("transport failure (GH #187)", () => {
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    };

    // Stalwart is down: the connection is refused/reset, so fetch REJECTS
    // (a TypeError) rather than returning a response. That never reaches the
    // status-based mapping, so before the fix it propagated raw to app.onError
    // and surfaced as a 500 "internal" — a known dependency being down reported
    // as if it were our own bug.
    function refusedFetch(): typeof fetch {
      return vi.fn(async () => {
        throw new TypeError("Unable to connect. Is the computer able to access the url?");
      }) as unknown as typeof fetch;
    }

    it("maps a refused connection on getSession to stalwart_unavailable (502)", async () => {
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: refusedFetch() });
      await expect(client.getSession(auth)).rejects.toMatchObject({
        code: "stalwart_unavailable",
        httpStatus: 502,
      });
    });

    it("maps a refused connection on request to stalwart_unavailable (502)", async () => {
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: refusedFetch() });
      await expect(
        client.request(auth, session, [["Mailbox/get", {}, "0"]]),
      ).rejects.toMatchObject({ code: "stalwart_unavailable", httpStatus: 502 });
    });

    it("maps a refused connection on uploadBlob to stalwart_unavailable (502)", async () => {
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: refusedFetch() });
      await expect(
        client.uploadBlob(auth, session, "script", "application/sieve"),
      ).rejects.toMatchObject({ code: "stalwart_unavailable", httpStatus: 502 });
    });

    it("lets the deadline's own timeout error pass through unchanged", async () => {
      // The transport mapping must not swallow the upstream_timeout (504) that
      // withDeadlineFetch raises — that is already a correct dependency error
      // and carries its own distinct status.
      vi.useFakeTimers();
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch,
      });
      const pending = client.request(auth, session, [["Mailbox/get", {}, "0"]]);
      const assertion = expect(pending).rejects.toMatchObject({
        code: "upstream_timeout",
        httpStatus: 504,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_STALWART_TIMEOUT_MS);
      await assertion;
      vi.useRealTimers();
    });
  });
});
