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

  it("is 'known' for a DMARC pass from an address the user has written to (Tier A)", () => {
    expect(
      resolveSenderTrust({ senderAuth: "pass", fromEmail: "ana@partner.test", knownRecipients, trustedDomains }),
    ).toBe("known");
  });

  it("is 'trusted-service' for a DMARC pass from a trusted domain (Tier B)", () => {
    expect(
      resolveSenderTrust({
        senderAuth: "pass",
        fromEmail: "noreply@github.com",
        knownRecipients,
        trustedDomains,
      }),
    ).toBe("trusted-service");
  });

  it("matches Tier B on a subdomain of a trusted entry", () => {
    expect(
      resolveSenderTrust({
        senderAuth: "pass",
        fromEmail: "notifications@noreply.github.com",
        knownRecipients,
        trustedDomains,
      }),
    ).toBe("trusted-service");
  });

  it("prefers 'trusted-service' when both tiers apply", () => {
    expect(
      resolveSenderTrust({
        senderAuth: "pass",
        fromEmail: "support@github.com",
        knownRecipients: new Set(["support@github.com"]),
        trustedDomains,
      }),
    ).toBe("trusted-service");
  });

  it("is 'none' on DMARC fail even for a known correspondent — fail is the only warning, and it wins", () => {
    expect(
      resolveSenderTrust({ senderAuth: "fail", fromEmail: "ana@partner.test", knownRecipients, trustedDomains }),
    ).toBe("none");
  });

  it("is 'none' on DMARC unknown even for a trusted domain — absence of a pass is not a pass", () => {
    expect(
      resolveSenderTrust({
        senderAuth: "unknown",
        fromEmail: "noreply@github.com",
        knownRecipients,
        trustedDomains,
      }),
    ).toBe("none");
  });

  it("is 'none' on a DMARC pass from a stranger — DMARC alone never yields trust", () => {
    expect(
      resolveSenderTrust({
        senderAuth: "pass",
        fromEmail: "stranger@elsewhere.test",
        knownRecipients,
        trustedDomains,
      }),
    ).toBe("none");
  });

  it("is 'none' for a look-alike domain (githiib.com) despite a DMARC pass", () => {
    expect(
      resolveSenderTrust({ senderAuth: "pass", fromEmail: "noreply@githiib.com", knownRecipients, trustedDomains }),
    ).toBe("none");
  });

  it("normalises case on the From address for both tiers", () => {
    expect(
      resolveSenderTrust({ senderAuth: "pass", fromEmail: "ANA@Partner.TEST", knownRecipients, trustedDomains }),
    ).toBe("known");
    expect(
      resolveSenderTrust({ senderAuth: "pass", fromEmail: "NoReply@GitHub.COM", knownRecipients, trustedDomains }),
    ).toBe("trusted-service");
  });

  it("requires the EXACT address for Tier A — a sibling at the same domain is not known", () => {
    expect(
      resolveSenderTrust({ senderAuth: "pass", fromEmail: "bob@partner.test", knownRecipients, trustedDomains }),
    ).toBe("none");
  });

  it("is 'none' when the message has no usable From address", () => {
    expect(
      resolveSenderTrust({ senderAuth: "pass", fromEmail: undefined, knownRecipients, trustedDomains }),
    ).toBe("none");
    expect(resolveSenderTrust({ senderAuth: "pass", fromEmail: "", knownRecipients, trustedDomains })).toBe(
      "none",
    );
  });
});
