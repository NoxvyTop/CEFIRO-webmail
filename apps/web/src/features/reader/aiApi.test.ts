import { describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import { fetchSummary, summarizeThread } from "./aiApi";

describe("fetchSummary", () => {
  it("posts to the summarize endpoint and returns the bullets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bullets: ["a", "b", "c"] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSummary("e1");

    expect(result).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/e1/summarize", { method: "POST" });
  });

  it("throws a MailApiError with the response code on failure", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: "ai_disabled" }), { status: 501 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSummary("e1")).rejects.toMatchObject(
      new MailApiError(501, "ai_disabled"),
    );
  });
});

describe("summarizeThread", () => {
  it("posts to the thread summarize endpoint and returns the bullets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bullets: ["a", "b"] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await summarizeThread("t1");

    expect(result).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/threads/t1/summarize", { method: "POST" });
  });

  it("throws a MailApiError with the response code on failure", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: "ai_disabled" }), { status: 501 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(summarizeThread("t1")).rejects.toMatchObject(
      new MailApiError(501, "ai_disabled"),
    );
  });
});
