import { describe, expect, it, vi } from "vitest";
import {
  MailApiError, copyMessageToInbox, destroyMessage, fetchInstanceSettings, fetchMailboxes,
  fetchMessages, fetchSharedAccounts, fetchThread, updateMessage,
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

// GH #13/#50: shared-mailbox access threads the active account into every mail
// request as `?accountId=`; personal (no accountId) stays byte-identical.
describe("shared-mailbox account scoping", () => {
  function stubFetch(body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body))) as unknown as (
      input: string,
      init?: RequestInit,
    ) => Promise<Response>;
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetches the shared accounts from /api/mail/shared-accounts", async () => {
    const fetchMock = stubFetch([{ id: "acc-shared", name: "Ventas" }]);
    const accounts = await fetchSharedAccounts();
    expect(accounts).toEqual([{ id: "acc-shared", name: "Ventas" }]);
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toBe("/api/mail/shared-accounts");
  });

  it("appends accountId to the mailboxes request", async () => {
    const fetchMock = stubFetch([]);
    await fetchMailboxes("acc-shared");
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toBe("/api/mail/mailboxes?accountId=acc-shared");
  });

  it("omits the accountId param for the personal mailbox", async () => {
    const fetchMock = stubFetch([]);
    await fetchMailboxes();
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toBe("/api/mail/mailboxes");
  });

  it("adds accountId to the messages query string", async () => {
    const fetchMock = stubFetch({ total: 0, position: 0, emails: [] });
    await fetchMessages({ mailboxId: "mb1", position: 0, limit: 50, accountId: "acc-shared" });
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toContain("accountId=acc-shared");
  });

  it("appends accountId to a thread request", async () => {
    const fetchMock = stubFetch({ id: "t1", emails: [] });
    await fetchThread("t1", "acc-shared");
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toBe("/api/mail/threads/t1?accountId=acc-shared");
  });

  it("appends accountId to update and destroy requests", async () => {
    const updateMock = stubFetch({ ok: true });
    await updateMessage("e1", { keywords: { $seen: true } }, "acc-shared");
    expect(String((updateMock as any).mock.calls[0]?.[0])).toBe("/api/mail/messages/e1?accountId=acc-shared");

    const destroyMock = stubFetch({ ok: true });
    await destroyMessage("e1", "acc-shared");
    const [url, init] = (destroyMock as any).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("/api/mail/messages/e1?accountId=acc-shared");
    expect(init?.method).toBe("DELETE");
  });

  // GH #13/#50 (G-2): copy-to-my-inbox POSTs to the copy endpoint with the
  // shared account it is being read from.
  it("POSTs to the copy-to-inbox endpoint with the shared accountId", async () => {
    const copyMock = stubFetch({ ok: true });
    await copyMessageToInbox("e1", "acc-shared");
    const [url, init] = (copyMock as any).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("/api/mail/messages/e1/copy-to-inbox?accountId=acc-shared");
    expect(init?.method).toBe("POST");
  });

  it("surfaces the envelope code when the copy request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "copy_failed", message: "x", traceId: "t" }), {
          status: 502,
        }),
      ),
    );
    await expect(copyMessageToInbox("e1", "acc-shared")).rejects.toMatchObject({
      status: 502,
      code: "copy_failed",
    });
  });
});
