import { afterAll, describe, expect, it } from "vitest";
import i18n from "./i18n";
import {
  errorMessageKey,
  SERVER_ERROR_CODES,
  type ErrorNamespace,
} from "./errorMessages";
import { MailApiError } from "../features/mailbox/api";
import { mailErrorKey } from "../features/mailbox/queryErrors";
import { settingsErrorKey } from "../features/settings/errors";

// GH #255: `settings` was the last namespace still resolving codes through a
// hand-maintained allowlist of its own, so it was also the last one this walk
// did not cover.
const NAMESPACES: ErrorNamespace[] = ["mail", "composer", "settings"];
const LANGUAGES = ["es", "en"];

afterAll(async () => {
  await i18n.changeLanguage("es");
});

// GH #215: the coverage walk the issue asks for. It fails if ANY code the
// server can emit would reach the user as something other than a real message
// — which is exactly what happened when ThreadView interpolated a raw code
// into a key nobody had defined and i18next handed the key straight back.
describe("server error code coverage", () => {
  for (const language of LANGUAGES) {
    for (const namespace of NAMESPACES) {
      it.each(SERVER_ERROR_CODES)(
        `${language}/${namespace}: %s resolves to a real message`,
        async (code) => {
          await i18n.changeLanguage(language);
          const key = errorMessageKey(namespace, code);

          expect(i18n.exists(key)).toBe(true);
          const message = i18n.t(key);
          expect(message).not.toBe(key);
          expect(message).not.toContain(`${namespace}.errors.`);
          expect(message.trim().length).toBeGreaterThan(0);
        },
      );
    }
  }
});

describe("errorMessageKey", () => {
  it("keeps a code that has its own message", () => {
    expect(errorMessageKey("mail", "mail_not_configured")).toBe("mail.errors.mail_not_configured");
    expect(errorMessageKey("composer", "send_failed")).toBe("composer.errors.send_failed");
    expect(errorMessageKey("settings", "sieve_invalid")).toBe("settings.errors.sieve_invalid");
  });

  it("falls back to the namespace's generic message for an unmapped code", () => {
    expect(errorMessageKey("mail", "jmap_error")).toBe("mail.errors.generic");
    expect(errorMessageKey("composer", "stalwart_unavailable")).toBe("composer.errors.generic");
    expect(errorMessageKey("settings", "jmap_error")).toBe("settings.errors.generic");
  });

  it("falls back to generic for a missing or empty code", () => {
    expect(errorMessageKey("mail", null)).toBe("mail.errors.generic");
    expect(errorMessageKey("mail", undefined)).toBe("mail.errors.generic");
    expect(errorMessageKey("composer", "")).toBe("composer.errors.generic");
  });
});

// The other half of GH #215: mailErrorKey's own two-entry allowlist left these
// eight already-translated messages unreachable.
describe("mailErrorKey reaches the messages that already existed", () => {
  it.each([
    "upstream_timeout",
    "database_unavailable",
    "not_in_trash",
    "destroy_failed",
    "ai_disabled",
    "ai_provider_error",
    "ai_rate_limited",
    "mail_credentials_missing",
  ])("maps %s to its own message instead of the generic one", (code) => {
    expect(mailErrorKey(new MailApiError(500, code))).toBe(`mail.errors.${code}`);
  });
});

// GH #255: the settings half of the same story. The old KNOWN_CODES allowlist
// happened to agree with the bundle at the moment it was written; what the
// bundle now guarantees is that it cannot fall behind it again.
describe("settingsErrorKey resolves through the bundle, not an allowlist", () => {
  it.each([
    "invalid_body",
    "invalid_order",
    "not_found",
    "sieve_invalid",
    "sieve_sync_failed",
    "contact_exists",
  ])("maps %s to its own message", (code) => {
    expect(settingsErrorKey(new MailApiError(500, code))).toBe(`settings.errors.${code}`);
  });

  it("falls back to the settings generic message for a code with no message", () => {
    expect(settingsErrorKey(new MailApiError(500, "jmap_error"))).toBe("settings.errors.generic");
  });

  it("falls back to generic for an error that is not a MailApiError", () => {
    expect(settingsErrorKey(new Error("boom"))).toBe("settings.errors.generic");
  });
});

describe("i18n missing-key handler", () => {
  it("renders the generic message for an unmapped error key rather than the key", () => {
    const rendered = i18n.t("mail.errors.some_code_nobody_translated");

    expect(rendered).toBe(i18n.t("mail.errors.generic"));
    expect(rendered).not.toContain("mail.errors.");
  });

  it("uses the namespace's own generic message, not a global one", () => {
    expect(i18n.t("composer.errors.some_code_nobody_translated")).toBe(
      i18n.t("composer.errors.generic"),
    );
  });

  it("leaves a non-error missing key returning the key, so a copy defect stays visible", () => {
    expect(i18n.t("mail.thereIsNoSuchLabel")).toBe("mail.thereIsNoSuchLabel");
  });

  it("returns the key when even the generic message is missing", () => {
    expect(i18n.t("nosuchnamespace.errors.whatever")).toBe("nosuchnamespace.errors.whatever");
  });
});
