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
import type { JmapClient } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

const stubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/dl/{accountId}/{blobId}/{name}?accept={type}",
  }),
  request: async () => [],
  uploadBlob: async () => "blob-id",
};

const stubJmapEmpty: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "",
    downloadUrl: "",
  }),
  request: async () => [],
  uploadBlob: async () => "blob-id",
};

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let token: string;
let tokenEmpty: string;

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

  const withCredEmpty = await users.create({
    email: `m-empty-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Empty Template User",
  });
  await mailCredentials.set(withCredEmpty.id, "mailbox-pw");
  tokenEmpty = (await sessions.create(withCredEmpty.id, 1)).token;
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

describe("POST /api/mail/blobs", () => {
  beforeAll(() => {
    fetchCallCount = 0;
  });

  it("requires a session", async () => {
    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/blobs", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("uploads the body to the upstream URL with substituted accountId and auth header", async () => {
    upstreamResponse = new Response(
      JSON.stringify({ blobId: "b1", type: "image/png", size: 1234 }),
      { status: 200 },
    );

    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/blobs", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe("https://mail.test/upload/acc-1/");
    const init = capturedInit as RequestInit & { duplex?: string };
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    expect(headers["content-type"]).toBe("image/png");
    expect(init.duplex).toBe("half");

    const body = (await res.json()) as { blobId: string; type: string; size: number };
    expect(body).toEqual({ blobId: "b1", type: "image/png", size: 1234 });
  });

  it("defaults content-type to application/octet-stream when not provided", async () => {
    upstreamResponse = new Response(
      JSON.stringify({ blobId: "b2", type: "application/octet-stream", size: 0 }),
      { status: 200 },
    );

    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/blobs", {
      method: "POST",
      headers: { cookie: `session=${token}` },
      body: new Uint8Array([1]),
    });

    expect(res.status).toBe(200);
    const headers = (capturedInit as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
  });

  it("returns 502 stalwart_unavailable when upstream responds non-ok", async () => {
    upstreamResponse = new Response(null, { status: 500 });

    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/blobs", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
  });

  it("returns 502 stalwart_unavailable when the connection to Stalwart is refused", async () => {
    // GH #211: the upload deliberately uses the undeadlined fetch, so nothing
    // else was mapping its transport failures — a Stalwart that is DOWN made
    // the attachment upload answer 500 "internal".
    const res = await makeApp(stubJmap, refusingFetch).request("/api/mail/blobs", {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
  });

  it("returns 502 stalwart_unavailable when uploadUrl template is empty", async () => {
    const beforeCount = fetchCallCount;
    const res = await makeApp(stubJmapEmpty, stubFetch()).request("/api/mail/blobs", {
      method: "POST",
      headers: { cookie: `session=${tokenEmpty}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
    expect(fetchCallCount).toBe(beforeCount);
  });
});

describe("GET /api/mail/blobs/:blobId", () => {
  it("requires a session", async () => {
    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/blobs/b1");
    expect(res.status).toBe(401);
  });

  it("streams the blob through with substituted URL, auth header, immutable cache-control, and inline disposition", async () => {
    upstreamResponse = new Response("file-bytes", {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "10" },
    });

    const res = await makeApp(stubJmap, stubFetch()).request(
      "/api/mail/blobs/b1?name=my%20file.png&type=image%2Fpng",
      { headers: { cookie: `session=${token}` } },
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      "https://mail.test/dl/acc-1/b1/my%20file.png?accept=image%2Fpng",
    );
    const headers = (capturedInit as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);

    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent("my file.png")}`,
    );
    const body = await res.text();
    expect(body).toBe("file-bytes");
  });

  it("returns attachment disposition when dl=1", async () => {
    upstreamResponse = new Response("file-bytes", {
      status: 200,
      headers: { "content-type": "image/png" },
    });

    const res = await makeApp(stubJmap, stubFetch()).request(
      "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf&dl=1",
      { headers: { cookie: `session=${token}` } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("report.pdf")}`,
    );
  });

  it("forwards the range header and passes through a 206 partial response", async () => {
    upstreamResponse = new Response("bytes-slice", {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-10/100",
        "accept-ranges": "bytes",
      },
    });

    const res = await makeApp(stubJmap, stubFetch()).request(
      "/api/mail/blobs/b1?name=movie.mp4&type=video%2Fmp4",
      {
        headers: { cookie: `session=${token}`, range: "bytes=0-10" },
      },
    );

    expect(res.status).toBe(206);
    const headers = (capturedInit as RequestInit).headers as Record<string, string>;
    expect(headers.range).toBe("bytes=0-10");
    expect(res.headers.get("content-range")).toBe("bytes 0-10/100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("falls back to the type query param for content-type when upstream doesn't provide one", async () => {
    upstreamResponse = new Response("bytes", { status: 200 });
    upstreamResponse.headers.delete("content-type");

    const res = await makeApp(stubJmap, stubFetch()).request(
      "/api/mail/blobs/b1?name=x&type=application%2Fpdf",
      { headers: { cookie: `session=${token}` } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("returns 502 stalwart_unavailable when upstream responds non-ok", async () => {
    upstreamResponse = new Response(null, { status: 404 });

    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/blobs/b1?name=x&type=y", {
      headers: { cookie: `session=${token}` },
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
  });

  it("returns 502 stalwart_unavailable when the connection to Stalwart is refused", async () => {
    // GH #211: a rejecting fetch, not an !ok response — the download used to
    // surface a down Stalwart as a 500 "internal".
    const res = await makeApp(stubJmap, refusingFetch).request(
      "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf",
      { headers: { cookie: `session=${token}` } },
    );

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
  });

  it("returns 502 stalwart_unavailable when downloadUrl template is empty", async () => {
    const beforeCount = fetchCallCount;
    const res = await makeApp(stubJmapEmpty, stubFetch()).request("/api/mail/blobs/b1", {
      headers: { cookie: `session=${tokenEmpty}` },
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stalwart_unavailable");
    expect(fetchCallCount).toBe(beforeCount);
  });

  it("defaults name to attachment and type to application/octet-stream when not provided", async () => {
    upstreamResponse = new Response("bytes", { status: 200 });

    const res = await makeApp(stubJmap, stubFetch()).request("/api/mail/blobs/b1", {
      headers: { cookie: `session=${token}` },
    });

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      "https://mail.test/dl/acc-1/b1/attachment?accept=application%2Foctet-stream",
    );
    expect(res.headers.get("content-disposition")).toBe(`inline; filename*=UTF-8''attachment`);
  });

  it("forces attachment disposition and neutralizes content-type for text/html (stored-XSS prevention)", async () => {
    upstreamResponse = new Response("<script>alert(1)</script>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    const res = await makeApp(stubJmap, stubFetch()).request(
      "/api/mail/blobs/b1?name=evil.html&type=text%2Fhtml",
      { headers: { cookie: `session=${token}` } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("allows inline disposition for safe-listed application/pdf and still sets hardening headers", async () => {
    upstreamResponse = new Response("%PDF-1.4", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });

    const res = await makeApp(stubJmap, stubFetch()).request(
      "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf",
      { headers: { cookie: `session=${token}` } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("forces attachment disposition and neutralizes content-type for image/svg+xml (script vector, never safe)", async () => {
    upstreamResponse = new Response("<svg onload='alert(1)'></svg>", {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    });

    const res = await makeApp(stubJmap, stubFetch()).request(
      "/api/mail/blobs/b1?name=evil.svg&type=image%2Fsvg%2Bxml",
      { headers: { cookie: `session=${token}` } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  describe("outbound deadline (GH #165)", () => {
    /** Stalwart accepts the download and then never answers. */
    const silentFetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    it("returns 504 upstream_timeout instead of hanging forever", async () => {
      const res = await makeApp(stubJmap, silentFetch, 50).request(
        "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf",
        { headers: { cookie: `session=${token}` } },
      );

      expect(res.status).toBe(504);
      expect(((await res.json()) as { code: string }).code).toBe("upstream_timeout");
    });

    it("keeps aborting the upstream when the client cancels the download mid-stream", async () => {
      upstreamResponse = new Response(
        new ReadableStream({
          start() {
            // Never closes: a large attachment still being relayed.
          },
        }),
        { status: 200, headers: { "content-type": "application/pdf" } },
      );
      const client = new AbortController();

      const res = await makeApp(stubJmap, stubFetch(), 50).request(
        new Request("http://localhost/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf", {
          headers: { cookie: `session=${token}` },
          signal: client.signal,
        }),
      );

      expect(res.status).toBe(200);
      const upstreamSignal = (capturedInit as RequestInit).signal;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(upstreamSignal?.aborted).toBe(false);

      client.abort();
      expect(upstreamSignal?.aborted).toBe(true);
    });
  });
});
