import { afterEach, describe, expect, it, vi } from "vitest";
import { createContact, deleteContact, fetchContacts, searchContacts } from "./api";

const contact = { id: "c1", name: "Ana Lopez", email: "ana@example.com", source: "manual" as const };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contacts api client", () => {
  it("fetches and validates the contact list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([contact]))));
    const result = await fetchContacts();
    expect(result).toEqual([contact]);
  });

  it("throws MailApiError with the envelope code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "internal", message: "errors.internal", traceId: "t1" }), {
          status: 500,
        }),
      ),
    );
    await expect(fetchContacts()).rejects.toMatchObject({ status: 500, code: "internal" });
  });

  it("GETs the search endpoint with the query as a q param", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([contact])));
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchContacts("ana");
    expect(result).toEqual([contact]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/mail/contacts/search?q=ana");
  });

  it("encodes special characters in the search query", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([])));
    vi.stubGlobal("fetch", fetchMock);
    await searchContacts("a&b c");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/mail/contacts/search?q=a%26b%20c");
  });

  it("POSTs a new contact", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(contact)));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createContact({ name: "Ana Lopez", email: "ana@example.com" });
    expect(result).toEqual(contact);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/contacts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Ana Lopez", email: "ana@example.com" });
  });

  it("throws MailApiError with contact_exists on a duplicate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "contact_exists", message: "errors.contact_exists", traceId: "t1" }), {
          status: 409,
        }),
      ),
    );
    await expect(createContact({ name: "", email: "dup@example.com" })).rejects.toMatchObject({
      status: 409,
      code: "contact_exists",
    });
  });

  it("DELETEs a contact by id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    await deleteContact("c1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/contacts/c1");
    expect(init.method).toBe("DELETE");
  });

  it("rejects invalid response shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ nope: 1 }]))));
    await expect(fetchContacts()).rejects.toThrow();
  });
});
