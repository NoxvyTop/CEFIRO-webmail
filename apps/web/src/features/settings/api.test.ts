import { afterEach, describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import {
  createFilterRule,
  fetchFilterRules,
  fetchProfile,
  fetchVacationSettings,
  reorderFilterRules,
  syncFilters,
  updateProfile,
} from "./api";
import { settingsErrorKey } from "./errors";

const rule = {
  id: "r1",
  position: 0,
  name: "invoices",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "billing@" }],
  actions: [{ type: "fileinto", folder: "Invoices" }],
  enabled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings api", () => {
  it("fetches and parses filter rules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([rule]), { status: 200 })),
    );
    const rules = await fetchFilterRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("invoices");
  });

  it("throws MailApiError with the envelope code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: "sieve_sync_failed", message: "errors.sieve_sync_failed", traceId: "t1" }),
            { status: 502 },
          ),
      ),
    );
    await expect(
      createFilterRule({
        name: "x",
        matchType: "all",
        conditions: [{ field: "from", op: "contains", value: "a" }],
        actions: [{ type: "seen" }],
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 502, code: "sieve_sync_failed" });
  });

  it("sends the full ordered id list on reorder", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await reorderFilterRules(["b", "a"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/filters/order");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["b", "a"] });
  });

  it("posts to the sync endpoint and returns the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    );
    const result = await syncFilters();
    expect(result.status).toBe("ok");
  });

  it("parses vacation settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              enabled: false,
              subject: "",
              message: "",
              startsAt: null,
              endsAt: null,
              intervalDays: 7,
            }),
            { status: 200 },
          ),
      ),
    );
    const settings = await fetchVacationSettings();
    expect(settings.intervalDays).toBe(7);
  });

  it("fetches and parses the profile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ displayName: "Carla", email: "carla@noxvytop.com", avatarDataUrl: null }),
            { status: 200 },
          ),
      ),
    );
    const profile = await fetchProfile();
    expect(profile.displayName).toBe("Carla");
    expect(profile.avatarDataUrl).toBeNull();
  });

  it("PATCHes only the given fields on the profile and returns the updated view", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ displayName: "New", email: "carla@noxvytop.com", avatarDataUrl: null }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await updateProfile({ displayName: "New" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/profile");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ displayName: "New" });
    expect(result.displayName).toBe("New");
  });
});

describe("settingsErrorKey", () => {
  it("maps known codes to settings error keys", () => {
    expect(settingsErrorKey(new MailApiError(502, "sieve_sync_failed"))).toBe(
      "settings.errors.sieve_sync_failed",
    );
    expect(settingsErrorKey(new MailApiError(400, "invalid_order"))).toBe(
      "settings.errors.invalid_order",
    );
  });

  it("falls back to generic for unknown errors", () => {
    expect(settingsErrorKey(new Error("boom"))).toBe("settings.errors.generic");
    expect(settingsErrorKey(new MailApiError(500, "internal"))).toBe("settings.errors.generic");
  });
});
