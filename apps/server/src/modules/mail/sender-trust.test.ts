import { describe, expect, it } from "vitest";
import { domainOf, matchesTrustedDomain, resolveSenderTrust } from "./sender-trust";

// GH #314: the pure tier resolution. Every case below is one row of the
// security contract in the issue: trust is only ever asserted on a DMARC
// "pass" AND an exact address (Tier A) or exact-or-subdomain (Tier B) match,
// never on either half alone, and "none" is the answer to every doubt.
describe("domainOf", () => {
  it("returns the lowercased part after the last @", () => {
    expect(domainOf("Ana@Partner.Test")).toBe("partner.test");
    expect(domainOf("weird@local@host.example")).toBe("host.example");
  });

  it("returns null when there is no domain to speak of", () => {
    expect(domainOf("no-at-sign")).toBeNull();
    expect(domainOf("trailing@")).toBeNull();
    expect(domainOf("")).toBeNull();
    expect(domainOf(undefined)).toBeNull();
  });
});

describe("matchesTrustedDomain", () => {
  const trusted = new Set(["github.com", "partner.test"]);

  it("matches an exact entry", () => {
    expect(matchesTrustedDomain("github.com", trusted)).toBe(true);
  });

  it("matches a subdomain of an entry (noreply.github.com under github.com)", () => {
    expect(matchesTrustedDomain("noreply.github.com", trusted)).toBe(true);
    expect(matchesTrustedDomain("a.b.partner.test", trusted)).toBe(true);
  });

  it("does NOT match a look-alike or a domain that merely ends with the same characters", () => {
    expect(matchesTrustedDomain("githiib.com", trusted)).toBe(false);
    expect(matchesTrustedDomain("notgithub.com", trusted)).toBe(false);
    expect(matchesTrustedDomain("github.com.evil.test", trusted)).toBe(false);
  });

  it("does not match a parent of an entry", () => {
    expect(matchesTrustedDomain("com", trusted)).toBe(false);
  });

  it("compares case-insensitively", () => {
    expect(matchesTrustedDomain("NoReply.GitHub.COM", trusted)).toBe(true);
  });

  it("matches nothing against an empty set", () => {
    expect(matchesTrustedDomain("github.com", new Set())).toBe(false);
  });
});

describe("resolveSenderTrust", () => {
  const knownRecipients = new Set(["ana@partner.test"]);
  const trustedDomains = new Set(["github.com"]);

  // GH #314: `fromCount` and `dmarcFromDomain` are the DMARC-binding inputs
  // (see the module header). Defaulting them here to "one From address, and
  // DMARC evaluated exactly that address's domain" keeps each case below about
  // the tier rule it is testing; the binding itself has its own cases at the
  // end, where the defaults are overridden explicitly.
  function resolve(input: {
    senderAuth: Parameters<typeof resolveSenderTrust>[0]["senderAuth"];
    fromEmail: string | undefined | null;
    knownRecipients?: ReadonlySet<string>;
    trustedDomains?: ReadonlySet<string>;
    fromCount?: number;
    dmarcFromDomain?: string | null;
  }) {
    return resolveSenderTrust({
      senderAuth: input.senderAuth,
      fromEmail: input.fromEmail,
      knownRecipients: input.knownRecipients ?? knownRecipients,
      trustedDomains: input.trustedDomains ?? trustedDomains,
      fromCount: input.fromCount ?? 1,
      dmarcFromDomain:
        input.dmarcFromDomain === undefined ? domainOf(input.fromEmail) : input.dmarcFromDomain,
    });
  }

  it("is 'known' for a DMARC pass from an address the user has written to (Tier A)", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: "ana@partner.test" })).toBe("known");
  });

  it("is 'trusted-service' for a DMARC pass from a trusted domain (Tier B)", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: "noreply@github.com" })).toBe("trusted-service");
  });

  it("matches Tier B on a subdomain of a trusted entry", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: "notifications@noreply.github.com" })).toBe(
      "trusted-service",
    );
  });

  it("prefers 'trusted-service' when both tiers apply", () => {
    expect(
      resolve({
        senderAuth: "pass",
        fromEmail: "support@github.com",
        knownRecipients: new Set(["support@github.com"]),
      }),
    ).toBe("trusted-service");
  });

  it("is 'none' on DMARC fail even for a known correspondent — fail is the only warning, and it wins", () => {
    expect(resolve({ senderAuth: "fail", fromEmail: "ana@partner.test" })).toBe("none");
  });

  it("is 'none' on DMARC unknown even for a trusted domain — absence of a pass is not a pass", () => {
    expect(resolve({ senderAuth: "unknown", fromEmail: "noreply@github.com" })).toBe("none");
  });

  it("is 'none' on a DMARC pass from a stranger — DMARC alone never yields trust", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: "stranger@elsewhere.test" })).toBe("none");
  });

  it("is 'none' for a look-alike domain (githiib.com) despite a DMARC pass", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: "noreply@githiib.com" })).toBe("none");
  });

  it("normalises case on the From address for both tiers", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: "ANA@Partner.TEST" })).toBe("known");
    expect(resolve({ senderAuth: "pass", fromEmail: "NoReply@GitHub.COM" })).toBe("trusted-service");
  });

  it("requires the EXACT address for Tier A — a sibling at the same domain is not known", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: "bob@partner.test" })).toBe("none");
  });

  it("is 'none' when the message has no usable From address", () => {
    expect(resolve({ senderAuth: "pass", fromEmail: undefined })).toBe("none");
    expect(resolve({ senderAuth: "pass", fromEmail: "" })).toBe("none");
  });

  // GH #314 (JD-1): the verdict is only evidence about the domain DMARC
  // actually evaluated. Binding it to the address the reader sees is what the
  // three cases below pin.
  describe("DMARC/From binding", () => {
    it("is 'none' when DMARC evaluated a DIFFERENT domain than the visible From", () => {
      expect(
        resolve({ senderAuth: "pass", fromEmail: "ana@partner.test", dmarcFromDomain: "attacker.test" }),
      ).toBe("none");
      expect(
        resolve({ senderAuth: "pass", fromEmail: "noreply@github.com", dmarcFromDomain: "attacker.test" }),
      ).toBe("none");
    });

    it("is 'none' when no header.from could be read from the trusted header", () => {
      expect(resolve({ senderAuth: "pass", fromEmail: "ana@partner.test", dmarcFromDomain: null })).toBe(
        "none",
      );
    });

    it("is 'none' when the message carries more than one From address", () => {
      // RFC 5322 allows several; DMARC evaluates one. Which one the reader is
      // shown is then a rendering accident, so no tier may be asserted at all.
      expect(resolve({ senderAuth: "pass", fromEmail: "ana@partner.test", fromCount: 2 })).toBe("none");
      expect(resolve({ senderAuth: "pass", fromEmail: "noreply@github.com", fromCount: 2 })).toBe("none");
    });

    it("is 'none' when the message carries no From address at all", () => {
      expect(resolve({ senderAuth: "pass", fromEmail: "ana@partner.test", fromCount: 0 })).toBe("none");
    });

    it("compares the bound domain case-insensitively", () => {
      expect(
        resolve({ senderAuth: "pass", fromEmail: "ANA@Partner.TEST", dmarcFromDomain: "partner.test" }),
      ).toBe("known");
    });
  });
});
