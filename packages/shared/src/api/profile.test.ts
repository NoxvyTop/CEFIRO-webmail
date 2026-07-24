import { describe, expect, it } from "vitest";
import { profileViewSchema, updateProfileSchema } from "./profile";

const SMALL_PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

describe("profile contracts", () => {
  it("profileViewSchema accepts a null avatar", () => {
    const parsed = profileViewSchema.parse({
      displayName: "A",
      email: "a@x.com",
      avatarDataUrl: null,
    });
    expect(parsed.avatarDataUrl).toBeNull();
  });

  it("updateProfileSchema trims displayName, rejects whitespace-only, and enforces max length", () => {
    expect(updateProfileSchema.parse({ displayName: "  Carlos  " }).displayName).toBe("Carlos");
    expect(() => updateProfileSchema.parse({ displayName: "   " })).toThrow();
    expect(() => updateProfileSchema.parse({ displayName: "x".repeat(81) })).toThrow();
  });

  it("updateProfileSchema accepts a valid small avatar data URL and an explicit null", () => {
    expect(updateProfileSchema.parse({ avatar: SMALL_PNG_DATA_URL }).avatar).toBe(SMALL_PNG_DATA_URL);
    expect(updateProfileSchema.parse({ avatar: null }).avatar).toBeNull();
  });

  it("updateProfileSchema rejects an svg mime type", () => {
    const svgDataUrl = "data:image/svg+xml;base64,aGVsbG8=";
    expect(() => updateProfileSchema.parse({ avatar: svgDataUrl })).toThrow();
  });

  it("updateProfileSchema rejects an oversized avatar", () => {
    const oversizedBase64 = "A".repeat(1_500_000); // decodes to well over the ~1 MiB cap
    const oversized = `data:image/png;base64,${oversizedBase64}`;
    expect(() => updateProfileSchema.parse({ avatar: oversized })).toThrow();
  });
});
