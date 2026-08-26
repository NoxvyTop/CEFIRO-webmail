import { describe, expect, it } from "vitest";
import { TRUSTED_SERVICES_SEED } from "./trusted-services-seed";

// GH #314: the curated seed is matched against the lowercased From domain by
// exact-or-subdomain compare (see sender-trust.ts), so every entry must
// already be in canonical form — a stray uppercase letter or leading dot would
// silently never match and the badge would just not appear for that provider.
describe("TRUSTED_SERVICES_SEED (GH #314)", () => {
  it("is a non-trivial list of well-known providers", () => {
    expect(TRUSTED_SERVICES_SEED.size).toBeGreaterThanOrEqual(12);
    expect(TRUSTED_SERVICES_SEED.has("github.com")).toBe(true);
  });

  // GH #314 (JD-5): a seed entry turns "DMARC passed for this domain" into a
  // trusted-service badge, and the compare is exact-or-SUBDOMAIN. A domain
  // whose DMARC-aligned mail relays content authored by arbitrary third
  // parties — a Drive share invitation, a LinkedIn message, a Slack or
  // Workspace invite — therefore lets an attacker put their own text under
  // that badge with a genuine pass, using nothing but a free account. Those
  // domains are admission rule 4's exclusions and must stay out.
  it("admits no domain whose notifications relay third-party-authored content", () => {
    for (const relay of [
      "google.com",
      "dropbox.com",
      "linkedin.com",
      "slack.com",
      "atlassian.com",
      "facebook.com",
      "instagram.com",
      "x.com",
      "meta.com",
    ]) {
      expect(TRUSTED_SERVICES_SEED.has(relay)).toBe(false);
    }
  });

  // The precise sign-in/security surface is admissible where the
  // organisational domain is not: accounts.google.com does not carry
  // user-authored share invitations.
  it("keeps the precise Google sign-in domain rather than the organisational one", () => {
    expect(TRUSTED_SERVICES_SEED.has("accounts.google.com")).toBe(true);
  });

  it("stores every entry lowercased, trimmed, with no leading dot and at least one label separator", () => {
    for (const domain of TRUSTED_SERVICES_SEED) {
      expect(domain).toBe(domain.trim().toLowerCase());
      expect(domain.startsWith(".")).toBe(false);
      expect(domain.endsWith(".")).toBe(false);
      expect(domain).toContain(".");
    }
  });

  it("is frozen so nothing at runtime can widen the seed", () => {
    expect(Object.isFrozen(TRUSTED_SERVICES_SEED)).toBe(true);
    expect(() => (TRUSTED_SERVICES_SEED as Set<string>).add("evil.test")).toThrow();
  });
});
