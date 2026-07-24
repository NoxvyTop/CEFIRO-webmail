import { describe, expect, it, vi } from "vitest";
import {
  MailApiError, fetchInstanceSettings, fetchMailboxes, fetchMessages, fetchThread, updateMessage,
} from "./api";

const mailbox = {
  id: "mb1", name: "Inbox", parentId: null, role: "inbox",
  sortOrder: 0, unreadEmails: 1, totalEmails: 2,
};

describe("mail api client", () => {
  it("fetches and validates mailboxes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([mailbox]))));
    expect((await fetchMailboxes())[0]?.name).toBe("Inbox");
  });

  it("throws MailApiError with the envelope code on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: "mail_not_configured", message: "x", traceId: "t" }), { status: 503 }),
    ));
    await expect(fetchMailboxes()).rejects.toMatchObject({
      status: 503, code: "mail_not_configured",
    });
  });

  it("builds the messages query string with search", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ total: 0, position: 0, emails: [] })),
    ) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", fetchMock);
    await fetchMessages({ mailboxId: "mb1", position: 50, limit: 50, query: "urgent" });
    const url = String((fetchMock as any).mock.calls[0]?.[0]);
    expect(url).toContain("mailboxId=mb1");
    expect(url).toContain("position=50");
    expect(url).toContain("query=urgent");
  });

  it("PATCHes message updates", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }))) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", fetchMock);
    await updateMessage("e1", { keywords: { $seen: true } });
    const call = (fetchMock as any).mock.calls[0];
    if (call) {
      const [url, init] = call as [string, RequestInit];
      expect(String(url)).toBe("/api/mail/messages/e1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ keywords: { $seen: true } });
    }
  });

  it("rejects invalid response shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nope: 1 }))));
    await expect(fetchThread("t1")).rejects.toThrow();
  });

  it("fetches the public instance settings flag from /api/instance", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sentWithFooter: true }))) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", fetchMock);
    const settings = await fetchInstanceSettings();
    expect(settings.sentWithFooter).toBe(true);
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toBe("/api/instance");
  });
});
