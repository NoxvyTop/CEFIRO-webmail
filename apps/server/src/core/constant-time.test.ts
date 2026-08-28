import { describe, expect, it } from "vitest";
import { secretMatches } from "./constant-time";

describe("secretMatches (GH #346)", () => {
  it("accepts the exact secret", async () => {
    await expect(secretMatches("s3cret", "s3cret")).resolves.toBe(true);
    await expect(secretMatches("", "")).resolves.toBe(true);
  });

  it("rejects a wrong secret whatever it got right", async () => {
    // A prefix, a superstring and a same-length near-miss: all three have to
    // cost the same, which is the property the digest-plus-no-early-exit shape
    // buys and a `===` on the two hex strings did not.
    await expect(secretMatches("s3cre", "s3cret")).resolves.toBe(false);
    await expect(secretMatches("s3cretx", "s3cret")).resolves.toBe(false);
    await expect(secretMatches("s3crEt", "s3cret")).resolves.toBe(false);
    await expect(secretMatches("", "s3cret")).resolves.toBe(false);
  });
});
