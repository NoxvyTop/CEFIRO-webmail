import { describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import { fetchTrustedServices, trustService, untrustService } from "./trustApi";

// GH #314: the three calls behind the reader's trusted-service affordances.
describe("fetchTrustedServices", () => {
  it("reads the seed and user lists", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ seed: ["github.com"], user: ["partner.test"] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTrustedServices();

    expect(result).toEqual({ seed: ["github.com"], user: ["partner.test"] });
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/trusted-services");
  });

  it("throws a MailApiError with the response code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 })),
    );
    await expect(fetchTrustedServices()).rejects.toMatchObject(new MailApiError(401, "unauthorized"));
  });
});

describe("trustService", () => {
  it("PUTs the URL-encoded domain and returns the updated lists", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ seed: ["github.com"], user: ["partner.test"] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await trustService("partner.test");

    expect(result.user).toEqual(["partner.test"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/trusted-services/partner.test", { method: "PUT" });
  });

  it("encodes the domain so a malformed value cannot alter the path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ seed: [], user: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await trustService("a/b?c");

    expect(fetchMock).toHaveBeenCalledWith("/api/mail/trusted-services/a%2Fb%3Fc", { method: "PUT" });
  });

  it("throws a MailApiError with the response code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "invalid_domain" }), { status: 400 })),
    );
    await expect(trustService("com")).rejects.toMatchObject(new MailApiError(400, "invalid_domain"));
  });
});

describe("untrustService", () => {
  it("DELETEs the URL-encoded domain and returns the updated lists", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ seed: ["github.com"], user: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await untrustService("partner.test");

    expect(result.user).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/trusted-services/partner.test", { method: "DELETE" });
  });

  it("surfaces the seed refusal as a MailApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "trusted_service_seed" }), { status: 409 })),
    );
    await expect(untrustService("github.com")).rejects.toMatchObject(
      new MailApiError(409, "trusted_service_seed"),
    );
  });
});
