import { describe, expect, it, vi } from "vitest";
import { deriveGroupAddresses, fetchPreferences, updatePreferences } from "./groups";

const primary = { id: "i1", name: "Primary", email: "user@noxvytop.com" };
const groupA = { id: "i2", name: "Sales", email: "sales@noxvytop.com" };
const groupB = { id: "i3", name: "Support", email: "support@noxvytop.com" };

describe("deriveGroupAddresses", () => {
  it("returns identities whose email differs from the primary", () => {
    expect(deriveGroupAddresses([primary, groupA, groupB], primary.email)).toEqual([groupA, groupB]);
  });

  it("excludes the primary case-insensitively", () => {
    const upper = { ...primary, email: primary.email.toUpperCase() };
    expect(deriveGroupAddresses([upper, groupA], primary.email)).toEqual([groupA]);
  });

  it("is empty when only the primary identity exists", () => {
    expect(deriveGroupAddresses([primary], primary.email)).toEqual([]);
  });
});

describe("preferences client", () => {
  it("fetches and validates preferences", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ groupMailInMainInbox: true })),
    ) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPreferences()).resolves.toEqual({ groupMailInMainInbox: true });
    expect((fetchMock as any).mock.calls[0]?.[0]).toBe("/api/mail/preferences");
  });

  it("throws MailApiError when fetching preferences fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(fetchPreferences()).rejects.toMatchObject({ status: 500 });
  });

  it("PUTs the patch and validates the response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ groupMailInMainInbox: false })),
    ) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", fetchMock);
    await expect(updatePreferences({ groupMailInMainInbox: false })).resolves.toEqual({
      groupMailInMainInbox: false,
    });
    const call = (fetchMock as any).mock.calls[0];
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("/api/mail/preferences");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ groupMailInMainInbox: false });
  });

  it("throws MailApiError when updating preferences fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(updatePreferences({ groupMailInMainInbox: true })).rejects.toMatchObject({ status: 500 });
  });
});
