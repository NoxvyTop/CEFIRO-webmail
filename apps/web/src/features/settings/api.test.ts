import { afterEach, describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import {
  createFilterRule,
  deleteFilterRule,
  fetchFilterRules,
  fetchGeneratedSieveScript,
  fetchProfile,
  fetchSieveRawScript,
  fetchVacationSettings,
  reorderFilterRules,
  saveSieveRawScript,
  switchToRuleBuilder,
  syncFilters,
  updateFilterRule,
  updateProfile,
  updateVacationSettings,
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

// GH #228: this module sat at 69% lines / 50% branches while the package-wide
// gate stayed green. The gap was concentrated in the three write endpoints
// below (never called by any test) and in the not-ok branch of every reader,
// which is the branch that decides what the UI shows when the server says no.
describe("settings api — write endpoints and error branches", () => {
  const ruleInput = {
    name: "invoices",
    matchType: "all" as const,
    conditions: [{ field: "from" as const, op: "contains" as const, value: "billing@" }],
    actions: [{ type: "fileinto" as const, folder: "Invoices" }],
    enabled: true,
  };

  it("PUTs an updated rule to the id-scoped endpoint, encoding the id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rule), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateFilterRule("r 1/2", ruleInput);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/filters/r%201%2F2");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "invoices" });
    expect(updated.id).toBe("r1");
  });

  it("DELETEs the id-scoped endpoint and resolves with nothing", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteFilterRule("r1")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/filters/r1");
    expect(init.method).toBe("DELETE");
  });

  const vacationInput = {
    enabled: true,
    subject: "Fuera",
    message: "Vuelvo el lunes",
    startsAt: null,
    endsAt: null,
    intervalDays: 7,
  };

  it("PUTs vacation settings and returns the stored view", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(vacationInput), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateVacationSettings(vacationInput);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/vacation");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual(vacationInput);
    expect(result).toEqual(vacationInput);
  });

  it("re-validates vacation settings client-side before sending", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(vacationInput), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // enabled with a blank message is the refinement the schema rejects.
    await expect(updateVacationSettings({ ...vacationInput, message: "   " })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the envelope code from every endpoint's not-ok branch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "sieve_sync_failed", message: "errors.sieve_sync_failed" }), {
            status: 502,
          }),
      ),
    );
    const failing: Array<[string, Promise<unknown>]> = [
      ["fetchFilterRules", fetchFilterRules()],
      ["updateFilterRule", updateFilterRule("r1", ruleInput)],
      ["deleteFilterRule", deleteFilterRule("r1")],
      ["reorderFilterRules", reorderFilterRules(["r1"])],
      ["syncFilters", syncFilters()],
      ["fetchVacationSettings", fetchVacationSettings()],
      ["updateVacationSettings", updateVacationSettings(vacationInput)],
      ["fetchProfile", fetchProfile()],
      ["updateProfile", updateProfile({ displayName: "New" })],
    ];
    for (const [name, pending] of failing) {
      await expect(pending, name).rejects.toMatchObject({ status: 502, code: "sieve_sync_failed" });
    }
  });

  it("falls back to the internal code when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    await expect(fetchFilterRules()).rejects.toMatchObject({ status: 502, code: "internal" });
  });

  it("falls back to the internal code when the error body is JSON without a code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), { status: 500 })),
    );
    await expect(fetchProfile()).rejects.toMatchObject({ status: 500, code: "internal" });
  });
});

// GH #23: the advanced mode's four endpoints. The two writes are the whole
// ownership model on the wire — saving takes the script over, and the way back
// is its own call that never sends a script, so nothing about going back can
// overwrite what is stored.
describe("sieve advanced mode api (GH #23)", () => {
  const rawState = { mode: "raw", script: 'fileinto "Ops";\n', updatedAt: "2026-07-01T10:00:00.000Z" };

  it("reads the advanced state", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rawState), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchSieveRawScript()).toEqual(rawState);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/mail/filters/raw");
  });

  it("reads the generated seed from its own endpoint", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ script: "# rule: x\n" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchGeneratedSieveScript()).script).toBe("# rule: x\n");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/mail/filters/raw/generated");
  });

  it("sends the script verbatim on save", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rawState), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await saveSieveRawScript('fileinto "Ops";\n');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/filters/raw");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ script: 'fileinto "Ops";\n' });
  });

  it("surfaces a script the mail server refused as sieve_invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: "sieve_invalid", message: "errors.sieve_invalid", traceId: "t1" }),
            { status: 422 },
          ),
      ),
    );
    await expect(saveSieveRawScript("if header {")).rejects.toMatchObject({
      status: 422,
      code: "sieve_invalid",
    });
  });

  it("sends no script at all when handing the account back to the rule builder", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ...rawState, mode: "rules" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // The stored script comes BACK unchanged: this call cannot be the thing
    // that overwrites it, because it carries nothing to overwrite it with.
    expect((await switchToRuleBuilder()).script).toBe(rawState.script);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/filters/raw/rules");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
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

  // GH #124: the contacts create endpoint (POST /api/mail/contacts) returns
  // this code on a duplicate address — added here since ContactsSettings
  // reuses settingsErrorKey the same way ProfileSettings/VacationSettings do.
  it("maps contact_exists to its settings error key", () => {
    expect(settingsErrorKey(new MailApiError(409, "contact_exists"))).toBe(
      "settings.errors.contact_exists",
    );
  });
});
