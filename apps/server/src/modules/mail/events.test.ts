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
import type { JmapClient } from "../../infra/stalwart/jmap";

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
});
