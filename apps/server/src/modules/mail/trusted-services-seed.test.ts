import { describe, expect, it } from "vitest";
import { TRUSTED_SERVICES_SEED } from "./trusted-services-seed";

// GH #314: the curated seed is matched against the lowercased From domain by
// exact-or-subdomain compare (see sender-trust.ts), so every entry must
// already be in canonical form — a stray uppercase letter or leading dot would
// silently never match and the badge would just not appear for that provider.
describe("TRUSTED_SERVICES_SEED (GH #314)", () => {
  it("is a non-trivial list of well-known providers", () => {
    expect(TRUSTED_SERVICES_SEED.size).toBeGreaterThanOrEqual(20);
    expect(TRUSTED_SERVICES_SEED.has("github.com")).toBe(true);
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
