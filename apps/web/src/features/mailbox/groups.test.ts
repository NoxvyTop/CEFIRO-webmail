import { describe, expect, it, vi } from "vitest";
import { deriveGroupAddresses, fetchPreferences, mergeGroupEntries, updatePreferences } from "./groups";

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
    // customLabels, sharedMailboxCopyOptIn and trustedServices (GH #314)
    // default to [] when the server response omits them (backward compatible
    // with servers/fixtures that predate these fields).
    await expect(fetchPreferences()).resolves.toEqual({
      groupMailInMainInbox: true,
      customLabels: [],
      sharedMailboxCopyOptIn: [],
      trustedServices: [],
    });
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
      customLabels: [],
      sharedMailboxCopyOptIn: [],
      trustedServices: [],
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

  it("PUTs a customLabels patch and round-trips it through the response", async () => {
    const label = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [label] })),
    ) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", fetchMock);

    await expect(updatePreferences({ customLabels: [label] })).resolves.toEqual({
      groupMailInMainInbox: true,
      customLabels: [label],
      sharedMailboxCopyOptIn: [],
      trustedServices: [],
    });
    const [, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init?.body))).toEqual({ customLabels: [label] });
  });
});

// #340: the sidebar listed a row per group identity AND the shared mailboxes
// page listed a row per shared account, both named after the same group — two
// doors to the same team, one of which ("0 correos", no unread) looked broken.
describe("mergeGroupEntries", () => {
  const salesAccount = { id: "acc-sales", name: "sales@noxvytop.com", copyOptIn: false };

  it("folds a group identity and its shared account into one entry", () => {
    expect(mergeGroupEntries([groupA], [salesAccount])).toEqual([
      { key: "acc-sales", label: "sales@noxvytop.com", address: "sales@noxvytop.com", accountId: "acc-sales" },
    ]);
  });

  it("matches an account named with the bare local part", () => {
    // Stalwart names a group principal by its login name, which may or may not
    // carry the domain — both spellings mean the same team.
    const [entry] = mergeGroupEntries([groupA], [{ id: "acc-sales", name: "sales", copyOptIn: false }]);
    expect(entry?.accountId).toBe("acc-sales");
    expect(entry?.address).toBe("sales@noxvytop.com");
  });

  it("does not fold together same-local-part addresses on different domains", () => {
    const other = { id: "acc-other", name: "sales@other.com", copyOptIn: false };
    expect(mergeGroupEntries([groupA], [other])).toHaveLength(2);
  });

  it("keeps a shared account with no matching identity, named after the account", () => {
    expect(mergeGroupEntries([], [salesAccount])).toEqual([
      { key: "acc-sales", label: "sales@noxvytop.com", accountId: "acc-sales" },
    ]);
  });

  it("keeps a group identity with no shared account, named after the address", () => {
    expect(mergeGroupEntries([groupB], [])).toEqual([
      { key: "support@noxvytop.com", label: "support@noxvytop.com", address: "support@noxvytop.com" },
    ]);
  });

  it("lists the shared mailboxes first and never repeats a group", () => {
    const entries = mergeGroupEntries([groupA, groupB], [salesAccount]);
    expect(entries.map((entry) => entry.label)).toEqual([
      "sales@noxvytop.com",
      "support@noxvytop.com",
    ]);
  });
});
