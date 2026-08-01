import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JMAP_TIMEOUT_MS } from "../../core/deadline";
import {
  createJmapClient,
  jmapAuthHeader,
  resolveSessionUrls,
  type JmapMethodCall,
  type JmapSession,
} from "./client";

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

  // GH #34 / design GH #188. `rewrite` is the DEFAULT: the old default trusted
  // the advertisement, which is what made "discovery works, every call after it
  // 502s" the most common misconfiguration of this dependency.
  describe("advertised session URLs (JMAP_URL_MODE)", () => {
    it("rewrites advertised URLs to the connection origin by default, keeping path and query", async () => {
      const fetchFn = fetchReturning(advertisedElsewhere);
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
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

    it("rewrites onto a base URL that carries a path and a trailing slash", async () => {
      const client = createJmapClient({
        baseUrl: "https://proxy.test:9443/mail/",
        fetchFn: fetchReturning(advertisedElsewhere),
      });
      const session = await client.getSession(auth);
      expect(session.apiUrl).toBe("https://proxy.test:9443/jmap/");
    });

    it("trusts the server-advertised origin verbatim in trust mode", async () => {
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: fetchReturning(advertisedElsewhere),
        urlMode: "trust",
      });
      const session = await client.getSession(auth);
      expect(session.apiUrl).toBe("https://internal.mail.test:8080/jmap/");
      expect(session.uploadUrl).toBe(
        "https://internal.mail.test:8080/jmap/upload/{accountId}/",
      );
    });

    it("leaves an unadvertised URL empty rather than inventing an origin for it", async () => {
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: fetchReturning({
          apiUrl: "https://internal.mail.test:8080/jmap/",
          primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
        }),
      });
      const session = await client.getSession(auth);
      expect(session.uploadUrl).toBe("");
      expect(session.downloadUrl).toBe("");
      expect(session.eventSourceUrl).toBe("");
    });

    it("uploads to the rewritten uploadUrl with {accountId} still templated", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(advertisedElsewhere)))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ blobId: "blob-1" })),
        ) as unknown as typeof fetch;
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
      const session = await client.getSession(auth);
      await client.uploadBlob(auth, session, "hi", "text/plain");
      const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1]!;
      expect(String(url)).toBe("https://mail.test/jmap/upload/acc-1/");
    });

    it("resolveSessionUrls is pure and mode-driven", () => {
      const advertised = {
        apiUrl: "http://internal:8080/jmap/",
        eventSourceUrl: "",
        uploadUrl: "http://internal:8080/upload/{accountId}/",
        downloadUrl: "http://internal:8080/download/{blobId}",
      };
      expect(resolveSessionUrls(advertised, "https://mail.test", "trust")).toEqual(advertised);
      expect(resolveSessionUrls(advertised, "https://mail.test", "rewrite")).toEqual({
        apiUrl: "https://mail.test/jmap/",
        eventSourceUrl: "",
        uploadUrl: "https://mail.test/upload/{accountId}/",
        downloadUrl: "https://mail.test/download/{blobId}",
      });
    });
  });

  // GH #35. `basic` must stay byte-for-byte what it always was; `bearer` is the
  // only thing that lets a token/OAuth provider be talked to at all.
  describe("auth mode (JMAP_AUTH_MODE)", () => {
    it("builds a Basic header by default and a Bearer header on request", () => {
      expect(jmapAuthHeader(auth)).toBe(`Basic ${btoa("u@noxvytop.com:mailbox-pw")}`);
      expect(jmapAuthHeader(auth, "basic")).toBe(`Basic ${btoa("u@noxvytop.com:mailbox-pw")}`);
      expect(jmapAuthHeader(auth, "bearer")).toBe("Bearer mailbox-pw");
    });

    it("sends Bearer on session discovery, method calls and uploads", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(sessionBody)))
        .mockResolvedValueOnce(new Response(JSON.stringify({ methodResponses: [] })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ blobId: "blob-1" })),
        ) as unknown as typeof fetch;
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn,
        authMode: "bearer",
      });
      const session = await client.getSession(auth);
      await client.request(auth, session, [["Mailbox/get", {}, "0"]]);
      await client.uploadBlob(auth, session, "hi", "text/plain");
      const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
      for (const [, init] of calls) {
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer mailbox-pw");
      }
      expect(calls).toHaveLength(3);
    });

    it("still maps 401 to mail_auth_failed in bearer mode", async () => {
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: fetchReturning({}, 401),
        authMode: "bearer",
      });
      await expect(client.getSession(auth)).rejects.toMatchObject({
        code: "mail_auth_failed",
      });
    });
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
      await vi.advanceTimersByTimeAsync(DEFAULT_JMAP_TIMEOUT_MS);
      await assertion;
    });

    it("fails request with upstream_timeout when Stalwart never answers", async () => {
      vi.useFakeTimers();
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: silentFetch() });

      const pending = client.request(auth, session, [["Mailbox/get", {}, "0"]]);
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_JMAP_TIMEOUT_MS);
      await assertion;
    });

    it("fails uploadBlob with upstream_timeout when Stalwart never answers", async () => {
      vi.useFakeTimers();
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn: silentFetch() });

      const pending = client.uploadBlob(auth, session, "script", "application/sieve");
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_JMAP_TIMEOUT_MS);
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
      await vi.advanceTimersByTimeAsync(DEFAULT_JMAP_TIMEOUT_MS * 10);
      expect(result.apiUrl).toBe("https://mail.test/jmap/");
    });
  });

  describe("advertised capabilities (GH #36)", () => {
    it("exposes the session's capability URIs", async () => {
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: fetchReturning({
          ...sessionBody,
          capabilities: {
            "urn:ietf:params:jmap:core": {},
            "urn:ietf:params:jmap:mail": {},
            "urn:ietf:params:jmap:sieve": {},
          },
        }),
      });

      const session = await client.getSession(auth);

      expect(session.capabilities).toEqual([
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:sieve",
      ]);
    });

    it("reports an empty list — not undefined — when the session advertises none", async () => {
      // "Advertises nothing" is an answer; only a session this client never
      // built (a test fixture) may be `undefined`. See JmapSession.capabilities.
      const client = createJmapClient({
        baseUrl: "https://mail.test",
        fetchFn: fetchReturning(sessionBody),
      });

      const session = await client.getSession(auth);

      expect(session.capabilities).toEqual([]);
    });
  });

  // GH #144. RFC 8621 §4.2 obliges a server to reject an unrecognised property
  // with a method-level `invalidArguments`, and a method error fails the whole
  // batch — so a provider that does not implement `messageId`/`references`/
  // `inReplyTo` made GET /threads/:id answer 502 and no conversation could be
  // opened at all, while the message list (which never asks for them) kept
  // working. Losing the headers is acceptable; losing the reader is not.
  describe("degradable properties (GH #144)", () => {
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    };

    const threadCalls: JmapMethodCall[] = [
      ["Thread/get", { accountId: "acc-1", ids: ["t1"] }, "t"],
      [
        "Email/get",
        {
          accountId: "acc-1",
          properties: ["id", "subject", "messageId", "references", "inReplyTo", "headers"],
        },
        "g",
      ],
    ];

    /** Answers each call with the next body, so a retry can be told from the first attempt. */
    function fetchSequence(bodies: unknown[]) {
      let call = 0;
      return vi.fn(async () => {
        const body = bodies[Math.min(call, bodies.length - 1)];
        call += 1;
        return new Response(JSON.stringify(body));
      }) as unknown as typeof fetch;
    }

    function sentProperties(fetchFn: typeof fetch, callIndex: number): unknown {
      const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[callIndex]!;
      return JSON.parse(init.body as string).methodCalls[1][1].properties;
    }

    const invalidArguments = {
      methodResponses: [["error", { type: "invalidArguments", arguments: ["properties"] }, "g"]],
    };
    const threadOk = {
      methodResponses: [
        ["Thread/get", { list: [{ id: "t1", emailIds: ["e1"] }] }, "t"],
        ["Email/get", { list: [{ id: "e1", subject: "Hi" }] }, "g"],
      ],
    };

    it("retries once without the optional properties and serves the degraded answer", async () => {
      const fetchFn = fetchSequence([invalidArguments, threadOk]);
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });

      const responses = await client.request(auth, session, threadCalls);

      expect(responses[1]?.[1]).toEqual({ list: [{ id: "e1", subject: "Hi" }] });
      expect(sentProperties(fetchFn, 0)).toEqual([
        "id",
        "subject",
        "messageId",
        "references",
        "inReplyTo",
        "headers",
      ]);
      // Only the degradable ones are dropped: the properties the view actually
      // needs are still asked for, so this is degradation, not a blank retry.
      expect(sentProperties(fetchFn, 1)).toEqual(["id", "subject"]);
    });

    it("stops asking for them once a provider has refused them", async () => {
      const fetchFn = fetchSequence([invalidArguments, threadOk]);
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });

      await client.request(auth, session, threadCalls);
      await client.request(auth, session, threadCalls);

      // Three posts, not four: the second conversation costs one round trip.
      expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
      expect(sentProperties(fetchFn, 2)).toEqual(["id", "subject"]);
    });

    it("does not retry an error that is not about an argument", async () => {
      const fetchFn = fetchSequence([{ methodResponses: [["error", { type: "serverFail" }, "g"]] }]);
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });

      await expect(client.request(auth, session, threadCalls)).rejects.toMatchObject({
        code: "jmap_error",
      });
      expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("never retries a batch that changes state", async () => {
      // A retry re-runs every call in the batch. Reading twice is free; sending
      // or filing a message twice is not, so a mutating batch fails as before.
      const fetchFn = fetchSequence([invalidArguments, threadOk]);
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });

      await expect(
        client.request(auth, session, [
          ["Email/set", { accountId: "acc-1", create: {} }, "s"],
          ["Email/get", { accountId: "acc-1", properties: ["id", "messageId"] }, "g"],
        ]),
      ).rejects.toMatchObject({ code: "jmap_error" });
      expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("does not retry when nothing degradable was asked for", async () => {
      const fetchFn = fetchSequence([invalidArguments]);
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });

      await expect(
        client.request(auth, session, [
          ["Email/get", { accountId: "acc-1", properties: ["id", "subject"] }, "g"],
        ]),
      ).rejects.toMatchObject({ code: "jmap_error" });
      expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("still fails when the degraded retry is refused too", async () => {
      const fetchFn = fetchSequence([invalidArguments, invalidArguments]);
      const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });

      await expect(client.request(auth, session, threadCalls)).rejects.toMatchObject({
        code: "jmap_error",
      });
      expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
      // A refused retry is not evidence about the provider, so the next call
      // must still ask for everything rather than degrade on a guess.
      await expect(client.request(auth, session, threadCalls)).rejects.toMatchObject({
        code: "jmap_error",
      });
      expect(sentProperties(fetchFn, 2)).toContain("messageId");
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
      await vi.advanceTimersByTimeAsync(DEFAULT_JMAP_TIMEOUT_MS);
      await assertion;
      vi.useRealTimers();
    });
  });
});
