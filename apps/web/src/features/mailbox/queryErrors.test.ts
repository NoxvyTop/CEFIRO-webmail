import { describe, expect, it } from "vitest";
import { MailApiError } from "./api";
import { isUnlinkedMailboxError, mailErrorKey, mailRetry } from "./queryErrors";

describe("mailErrorKey", () => {
  it("returns the known key for a MailApiError with a known code", () => {
    expect(mailErrorKey(new MailApiError(503, "mail_not_configured"))).toBe(
      "mail.errors.mail_not_configured",
    );
  });

  it("returns generic for a plain Error", () => {
    expect(mailErrorKey(new Error("network down"))).toBe("mail.errors.generic");
  });

  it("returns generic for an unknown MailApiError code", () => {
    expect(mailErrorKey(new MailApiError(500, "internal"))).toBe("mail.errors.generic");
  });
});

describe("mailRetry", () => {
  it("returns false for a 503 MailApiError", () => {
    expect(mailRetry(0, new MailApiError(503, "mail_not_configured"))).toBe(false);
  });

  it("returns false for a 404 MailApiError", () => {
    expect(mailRetry(0, new MailApiError(404, "not_found"))).toBe(false);
  });

  it("returns true (below the retry cap) for a plain network Error", () => {
    expect(mailRetry(0, new Error("network down"))).toBe(true);
    expect(mailRetry(2, new Error("network down"))).toBe(true);
    expect(mailRetry(3, new Error("network down"))).toBe(false);
  });
});

describe("isUnlinkedMailboxError", () => {
  it("returns true for a mail_credentials_missing MailApiError", () => {
    expect(isUnlinkedMailboxError(new MailApiError(503, "mail_credentials_missing"))).toBe(true);
  });

  it("returns false for mail_not_configured (a real server misconfiguration, not onboarding)", () => {
    expect(isUnlinkedMailboxError(new MailApiError(503, "mail_not_configured"))).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isUnlinkedMailboxError(new Error("network down"))).toBe(false);
  });
});
