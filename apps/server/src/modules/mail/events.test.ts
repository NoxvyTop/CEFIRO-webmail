import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { JmapClient } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

const stubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es?types={types}&closeafter={closeafter}&ping={ping}",
  }),
  request: async () => [],
};

const stubJmapNoEventSource: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "",
  }),
  request: async () => [],
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

function makeApp(jmap: JmapClient | null, fetchFn?: typeof fetch) {
  return createApp({
    mailRouter: createMailRouter({ sessions, mailCredentials, jmap, fetchFn }),
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
});
