import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAiDraft } from "./aiApi";

// GH #228: this module measured 10.52% lines / 0% functions — every exported
// function was unreached, so the request shape, the schema validation and the
// error translation below were all unprotected while the coverage gate stayed
// green on the package average.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composer AI draft client", () => {
  it("POSTs the validated subject as JSON and returns the drafted body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ body: "Estimado cliente…" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAiDraft("Presupuesto")).resolves.toBe("Estimado cliente…");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/compose/draft");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ subject: "Presupuesto" });
  });

  it("rejects an invalid subject before issuing any request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAiDraft("")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws MailApiError carrying the envelope code on a failed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "ai_unavailable", message: "errors.ai_unavailable" }), {
            status: 503,
          }),
      ),
    );
    await expect(fetchAiDraft("Presupuesto")).rejects.toMatchObject({
      status: 503,
      code: "ai_unavailable",
    });
  });

  it("falls back to the internal code when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    await expect(fetchAiDraft("Presupuesto")).rejects.toMatchObject({ status: 502, code: "internal" });
  });

  it("falls back to the internal code when the error body is JSON without a code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), { status: 500 })));
    await expect(fetchAiDraft("Presupuesto")).rejects.toMatchObject({ status: 500, code: "internal" });
  });

  it("rejects when a 200 response does not match the draft result schema", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "wrong field" }))));
    await expect(fetchAiDraft("Presupuesto")).rejects.toThrow();
  });
});
