import { describe, expect, it } from "vitest";
import { normalizeDomainName } from "./domain-name";

// GH #314: the trusted-services list is keyed on domain names that come from
// two untrusted places — the PUT route's URL parameter and a jsonb column that
// may have been edited by hand. Both go through this one normalizer so the
// stored form is always the canonical one the sender-trust compare expects.
describe("normalizeDomainName (GH #314)", () => {
  it("lowercases and trims a well-formed domain", () => {
    expect(normalizeDomainName("  GitHub.com ")).toBe("github.com");
    expect(normalizeDomainName("noreply.GitHub.com")).toBe("noreply.github.com");
  });

  it("accepts hyphenated labels and digits", () => {
    expect(normalizeDomainName("my-service-1.example")).toBe("my-service-1.example");
  });

  it("rejects a bare label with no dot — a TLD-only entry would trust an entire TLD", () => {
    expect(normalizeDomainName("com")).toBeNull();
    expect(normalizeDomainName("localhost")).toBeNull();
  });

  it("rejects leading/trailing dots, empty labels and hyphens at label edges", () => {
    expect(normalizeDomainName(".github.com")).toBeNull();
    expect(normalizeDomainName("github.com.")).toBeNull();
    expect(normalizeDomainName("github..com")).toBeNull();
    expect(normalizeDomainName("-github.com")).toBeNull();
    expect(normalizeDomainName("github-.com")).toBeNull();
  });

  it("rejects anything that is not a plain hostname: addresses, URLs, wildcards, spaces", () => {
    expect(normalizeDomainName("user@github.com")).toBeNull();
    expect(normalizeDomainName("https://github.com")).toBeNull();
    expect(normalizeDomainName("*.github.com")).toBeNull();
    expect(normalizeDomainName("git hub.com")).toBeNull();
    expect(normalizeDomainName("github.com/path")).toBeNull();
  });

  it("rejects non-string and empty input", () => {
    expect(normalizeDomainName("")).toBeNull();
    expect(normalizeDomainName("   ")).toBeNull();
    expect(normalizeDomainName(42)).toBeNull();
    expect(normalizeDomainName(null)).toBeNull();
    expect(normalizeDomainName(undefined)).toBeNull();
  });

  it("rejects a name longer than 253 characters or a label longer than 63", () => {
    expect(normalizeDomainName(`${"a".repeat(64)}.example`)).toBeNull();
    const tooLong = `${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.example`;
    expect(tooLong.length).toBeGreaterThan(253);
    expect(normalizeDomainName(tooLong)).toBeNull();
  });
});
