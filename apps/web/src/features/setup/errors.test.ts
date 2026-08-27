import { afterAll, describe, expect, it } from "vitest";
import i18n from "../../app/i18n";
import { setupErrorKey } from "./errors";

const LANGUAGES = ["es", "en"];

afterAll(async () => {
  await i18n.changeLanguage("es");
});

describe("setupErrorKey", () => {
  it("keeps a code that has its own setup message", () => {
    expect(setupErrorKey("user_exists")).toBe("setup.errors.user_exists");
    expect(setupErrorKey("unauthorized")).toBe("setup.errors.unauthorized");
    expect(setupErrorKey("network_error")).toBe("setup.errors.network_error");
    // GH #285: once the completion latch closes, a mid-wizard action gets 404
    // not_found, which now maps to its own "already completed" message instead
    // of the generic fallback.
    expect(setupErrorKey("not_found")).toBe("setup.errors.not_found");
  });

  it("falls back to the setup generic message for an unmapped code", () => {
    expect(setupErrorKey("jmap_error")).toBe("setup.errors.generic");
    expect(setupErrorKey("something_nobody_translated")).toBe("setup.errors.generic");
  });

  it("falls back to generic for a missing or empty code", () => {
    expect(setupErrorKey(null)).toBe("setup.errors.generic");
    expect(setupErrorKey(undefined)).toBe("setup.errors.generic");
    expect(setupErrorKey("")).toBe("setup.errors.generic");
  });

  // Every code the setup wizard can put on screen must resolve to a real
  // message in both languages, not a raw key (the GH #215 guarantee, scoped to
  // this feature's own namespace).
  for (const language of LANGUAGES) {
    it.each([
      "generic",
      "invalid_body",
      "network_error",
      "not_found",
      "too_many_requests",
      "unauthorized",
      "user_exists",
    ])(`${language}: %s resolves to a real message`, async (code) => {
      await i18n.changeLanguage(language);
      const key = setupErrorKey(code);
      expect(i18n.exists(key)).toBe(true);
      const message = i18n.t(key);
      expect(message).not.toBe(key);
      expect(message).not.toContain("setup.errors.");
      expect(message.trim().length).toBeGreaterThan(0);
    });
  }
});
