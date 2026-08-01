import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import { evictMailSession } from "./context";
import { DEFAULT_MAX_STREAMS_PER_USER } from "./streams";
import type { JmapClient } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

const stubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es?types={types}&closeafter={closeafter}&ping={ping}",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
  }),
  request: async () => [],
  uploadBlob: async () => "blob-id",
};

const stubJmapNoEventSource: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "",
    uploadUrl: "",
    downloadUrl: "",
  }),
  request: async () => [],
  uploadBlob: async () => "blob-id",
};

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let token: string;
let userId: string;
let tokenNoEventSource: string;

let capturedUrl: string | undefined;
let capturedInit: RequestInit | undefined;
let fetchCallCount = 0;
let upstreamResponse: Response;

function stubFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCallCount += 1;
    capturedUrl = String(input);
    capturedInit = init;
    return upstreamResponse;
  }) as typeof fetch;
}

/** Stalwart is down: the connection is refused, so fetch rejects (GH #211). */
const refusingFetch = (() =>
  Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  sessions = createSessionStore(sql);

  const withCred = await users.create({
    email: `m-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Mail User",
  });
  await mailCredentials.set(withCred.id, "mailbox-pw");
  userId = withCred.id;
  token = (await sessions.create(withCred.id, 1)).token;

  const withCredNoEventSource = await users.create({
    email: `m-nes-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "No Event Source User",
  });
  await mailCredentials.set(withCredNoEventSource.id, "mailbox-pw");
  tokenNoEventSource = (await sessions.create(withCredNoEventSource.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp(jmap: JmapClient | null, fetchFn?: typeof fetch, timeoutMs?: number) {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap,
      fetchFn,
      timeoutMs,
    }),
  });
}

describe("GET /api/mail/events", () => {
  beforeAll(() => {
    fetchCallCount = 0;
  });

  it("requires a session", async () => {
    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/events");
    expect(res.status).toBe(401);
  });

  it("streams the upstream event-source body through, replacing URL placeholders", async () => {
    upstreamResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('event: state\ndata: {"changed":true}\n\n'),
          );
          controller.close();
        },
      }),
      { status: 200 },
    );

    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/events", {
      headers: { cookie: `session=${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("connection")).toBe("keep-alive");

    const body = await res.text();
    expect(body).toBe('event: state\ndata: {"changed":true}\n\n');

    expect(capturedUrl).toBe(
      "https://mail.test/es?types=Email,Mailbox&closeafter=no&ping=30",
    );
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.accept).toBe("text/event-stream");
    expect(headers.authorization).toMatch(/^Basic /);
  });

  it("returns 502 stalwart_unavailable when upstream responds non-ok", async () => {
    upstreamResponse = new Response(null, { status: 500 });

    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/events", {
      headers: { cookie: `session=${token}` },
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
  });

  it("returns 502 stalwart_unavailable when eventSourceUrl is empty", async () => {
    const beforeCount = fetchCallCount;
    const res = await makeApp(stubJmapNoEventSource, stubFetch()).request("/api/mail/events", {
      headers: { cookie: `session=${tokenNoEventSource}` },
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
    expect(fetchCallCount).toBe(beforeCount);
  });

  it("returns 502 stalwart_unavailable when the connection to Stalwart is refused", async () => {
    // GH #211: a Stalwart that is DOWN makes fetch reject instead of answering
    // !ok, and that rejection used to reach app.onError as a 500 "internal".
    const res = await makeApp(stubJmap, refusingFetch).request("/api/mail/events", {
      headers: { cookie: `session=${token}` },
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
  });

  describe("outbound deadline (GH #165)", () => {
    /** Stalwart accepts the event-source connection and then never answers. */
    const silentFetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    it("returns 504 upstream_timeout instead of hanging forever", async () => {
      const res = await makeApp(stubJmap, silentFetch, 50).request("/api/mail/events", {
        headers: { cookie: `session=${token}` },
      });

      expect(res.status).toBe(504);
      expect(((await res.json()) as { code: string }).code).toBe("upstream_timeout");
    });

    it("stops counting once the stream starts, but still aborts it when the client leaves", async () => {
      // The deadline covers time-to-headers only: an event stream legitimately
      // stays open for minutes, and the client's own signal — which this route
      // has always forwarded — must keep tearing the upstream down.
      upstreamResponse = new Response(
        new ReadableStream({
          start() {
            // Never closes: a live event stream.
          },
        }),
        { status: 200 },
      );
      const client = new AbortController();

      const res = await makeApp(stubJmap, stubFetch(), 50).request(
        new Request("http://localhost/api/mail/events", {
          headers: { cookie: `session=${token}` },
          signal: client.signal,
        }),
      );

      expect(res.status).toBe(200);
      const upstreamSignal = capturedInit?.signal;
      // Well past the 50ms deadline, the open stream is untouched.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(upstreamSignal?.aborted).toBe(false);

      client.abort();
      expect(upstreamSignal?.aborted).toBe(true);
    });
  });

  // GH #241. This route clears Bun's idle timeout for its socket (correct — GH
  // #204), which left it as the one route with no deadline, no ceiling and no
  // bookkeeping at all. The registry in ./streams.ts owns all three; these pin
  // the two properties that are only observable through the route.
  describe("stream lifetime (GH #241)", () => {
    /** A live event stream: connected, nothing sent yet. */
    function liveUpstream(): Response {
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }

    function connect(app: ReturnType<typeof makeApp>) {
      return app.request("/api/mail/events", { headers: { cookie: `session=${token}` } });
    }

    it("caps how many streams one user can hold open", async () => {
      upstreamResponse = liveUpstream();
      const app = makeApp(stubJmap, stubFetch());
      const open: Response[] = [];
      for (let i = 0; i < DEFAULT_MAX_STREAMS_PER_USER; i += 1) {
        upstreamResponse = liveUpstream();
        const res = await connect(app);
        expect(res.status).toBe(200);
        open.push(res);
      }

      // One client looping on connect used to pin an unbounded number of
      // upstream Stalwart sockets, one per attempt, forever.
      const beforeCount = fetchCallCount;
      const refused = await connect(app);
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { code: string }).code).toBe("too_many_streams");
      // Refused BEFORE the upstream call, so it costs no Stalwart connection.
      expect(fetchCallCount).toBe(beforeCount);

      // Releasing one frees exactly one slot.
      await open[0]!.body?.cancel();
      upstreamResponse = liveUpstream();
      const readmitted = await connect(app);
      expect(readmitted.status).toBe(200);

      await Promise.all([...open.slice(1), readmitted].map((res) => res.body?.cancel()));
    });

    it("ends an in-flight stream when the session is invalidated", async () => {
      // The defect: evicting a session dropped the cached JMAP session and
      // nothing else, so a stream opened before logout kept delivering that
      // mailbox's events afterwards, on credentials that had been revoked.
      upstreamResponse = liveUpstream();
      const res = await connect(makeApp(stubJmap, stubFetch()));
      expect(res.status).toBe(200);
      const upstreamSignal = capturedInit?.signal;
      const reader = res.body!.getReader();
      const pending = reader.read();

      evictMailSession(userId);

      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      // And the Stalwart connection went with it rather than being abandoned.
      expect(upstreamSignal?.aborted).toBe(true);
    });
  });
});
