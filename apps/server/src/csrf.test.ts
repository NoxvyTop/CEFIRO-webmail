import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { apiErrorSchema } from "@webmail/shared";
import { createApp } from "./app";

const APP_URL = "https://mail.example.com";
const APP_ORIGIN = "https://mail.example.com";
const SIBLING_ORIGIN = "https://intranet.example.com";

type LogLine = Record<string, unknown>;

/** Same capture shape app.test.ts uses; core/logger.ts writes JSON lines. */
async function captureLogs(run: () => Response | Promise<Response>): Promise<{
  res: Response;
  lines: LogLine[];
}> {
  const lines: LogLine[] = [];
  const record = (...args: unknown[]) => {
    lines.push(JSON.parse(String(args[0])) as LogLine);
  };
  const spies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
  ];
  try {
    return { res: await run(), lines };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/**
 * A stand-in for the real routers: it answers 200 only if the request actually
 * reached a handler, which is what "passes through" has to mean here — a test
 * that only asserted "not 403" would pass against a 404 too.
 */
function makeApp() {
  const mailRouter = new Hono();
  mailRouter.post("/send", (c) => c.json({ reached: "send" }));
  mailRouter.post("/blobs", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json({ reached: "blobs", size: bytes.byteLength });
  });
  mailRouter.get("/messages", (c) => c.json({ reached: "messages" }));

  const authRouter = new Hono();
  authRouter.post("/logout", (c) => c.json({ ok: true }));

  return createApp({ appUrl: APP_URL, mailRouter, authRouter });
}

function jsonBody(extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify({ to: ["a@b.c"] }),
  };
}

describe("CSRF origin gate (GH #335)", () => {
  it("rejects a mutation carrying a foreign Origin", async () => {
    const res = await makeApp().request(
      "/api/mail/send",
      jsonBody({ origin: SIBLING_ORIGIN }),
    );
    expect(res.status).toBe(403);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("csrf");
  });

  it("rejects a same-site sibling subdomain, which SameSite=Lax lets through", async () => {
    // The whole point of the issue: `SameSite=Lax` still ships the cookie for a
    // request from another origin on the same registrable domain.
    const res = await makeApp().request(
      "/api/mail/send",
      jsonBody({ "sec-fetch-site": "same-site", origin: SIBLING_ORIGIN }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects Sec-Fetch-Site: cross-site even with no Origin at all", async () => {
    const res = await makeApp().request(
      "/api/mail/send",
      jsonBody({ "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
  });

  it("lets a same-origin mutation reach the handler", async () => {
    const res = await makeApp().request(
      "/api/mail/send",
      jsonBody({ "sec-fetch-site": "same-origin" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: "send" });
  });

  it("accepts Sec-Fetch-Site: none (a user-initiated request)", async () => {
    const res = await makeApp().request(
      "/api/mail/send",
      jsonBody({ "sec-fetch-site": "none" }),
    );
    expect(res.status).toBe(200);
  });

  it("falls back to a matching Origin when the browser sends no Sec-Fetch-Site", async () => {
    const res = await makeApp().request("/api/mail/send", jsonBody({ origin: APP_ORIGIN }));
    expect(res.status).toBe(200);
  });

  it("falls back to the Referer's origin when there is no Origin either", async () => {
    const res = await makeApp().request(
      "/api/mail/send",
      jsonBody({ referer: `${APP_ORIGIN}/mail/inbox` }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a Referer from a foreign origin", async () => {
    const res = await makeApp().request(
      "/api/mail/send",
      jsonBody({ referer: `${SIBLING_ORIGIN}/attack.html` }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a header-less mutation: no cookie route accepts a bearer token", async () => {
    const res = await makeApp().request("/api/mail/send", jsonBody());
    expect(res.status).toBe(403);
  });

  it("rejects a Referer that is not a URL", async () => {
    const res = await makeApp().request("/api/mail/send", jsonBody({ referer: "not a url" }));
    expect(res.status).toBe(403);
  });

  it("leaves GET untouched even from a foreign origin", async () => {
    const res = await makeApp().request("/api/mail/messages", {
      headers: { origin: SIBLING_ORIGIN, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(200);
  });

  it("leaves the readiness probe answering for a header-less caller", async () => {
    const res = await createApp({ appUrl: APP_URL }).request("/api/health/live");
    expect(res.status).toBe(200);
  });

  it("guards POST /api/auth/logout, which carries no session of its own", async () => {
    const cross = await makeApp().request("/api/auth/logout", {
      method: "POST",
      headers: { origin: SIBLING_ORIGIN },
    });
    expect(cross.status).toBe(403);

    const same = await makeApp().request("/api/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(same.status).toBe(200);
  });

  it("logs the refusal at warn with the route pattern and no body", async () => {
    const { res, lines } = await captureLogs(() =>
      makeApp().request("/api/mail/send", jsonBody({ origin: SIBLING_ORIGIN })),
    );
    expect(res.status).toBe(403);
    const refusal = lines.find((line) => line.msg === "csrf refused");
    expect(refusal).toBeDefined();
    expect(refusal?.level).toBe("warn");
    expect(refusal?.route).toBe("/api/mail/send");
    expect(JSON.stringify(refusal)).not.toContain("a@b.c");
  });

  it("falls back to the request's own origin when no APP_URL is wired", async () => {
    // createApp() without appUrl is what every test in this package builds.
    const mailRouter = new Hono();
    mailRouter.post("/send", (c) => c.json({ reached: "send" }));
    const app = createApp({ mailRouter });

    const same = await app.request("http://localhost/api/mail/send", jsonBody({
      origin: "http://localhost",
    }));
    expect(same.status).toBe(200);

    const foreign = await app.request("http://localhost/api/mail/send", jsonBody({
      origin: SIBLING_ORIGIN,
    }));
    expect(foreign.status).toBe(403);
  });

  it("ignores a malformed APP_URL rather than refusing every mutation", async () => {
    const mailRouter = new Hono();
    mailRouter.post("/send", (c) => c.json({ reached: "send" }));
    const app = createApp({ appUrl: "not a url", mailRouter });
    const res = await app.request("http://localhost/api/mail/send", jsonBody({
      origin: "http://localhost",
    }));
    expect(res.status).toBe(200);
  });
});

describe("JSON Content-Type enforcement (GH #335)", () => {
  it("rejects a body sent as a simple form content type", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "to=a%40b.c",
    });
    expect(res.status).toBe(415);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("unsupported_media_type");
  });

  it("rejects text/plain, which a cross-site form can also produce", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain" },
      body: '{"to":["a@b.c"]}',
    });
    expect(res.status).toBe(415);
  });

  it("accepts application/json with a charset parameter", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ to: ["a@b.c"] }),
    });
    expect(res.status).toBe(200);
  });

  it("leaves a body-less mutation alone: the SPA sends several", async () => {
    // e.g. POST /api/mail/filters/sync, DELETE /api/mail/signatures/:id.
    const res = await makeApp().request("/api/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  it("exempts the streamed attachment upload, which is binary by contract", async () => {
    const res = await makeApp().request("/api/mail/blobs", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/pdf" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: "blobs", size: 3 });
  });

  it("still applies the origin gate to the exempted upload", async () => {
    const res = await makeApp().request("/api/mail/blobs", {
      method: "POST",
      headers: { origin: SIBLING_ORIGIN, "content-type": "application/pdf" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a body whose content type is missing entirely", async () => {
    const res = await makeApp().request("/api/mail/send", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(415);
  });
});
