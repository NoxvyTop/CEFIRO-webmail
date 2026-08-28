import { describe, expect, it } from "vitest";
import { MailApiError } from "./api";
import { isUnlinkedMailboxError, mailErrorKey, mailRetry, mailRetryDelay } from "./queryErrors";

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

// GH #345: 502/503/504 are the codes a JMAP provider restart or upstream
// blip actually returns — used to be that 502/504 got the default 3 retries
// while 503 (Service Unavailable — arguably the MOST transient of the three)
// got none at all and failed immediately. All three now share one bounded
// (2-retry) allowance.
describe("mailRetry", () => {
  it("allows a bounded retry (2 attempts) for 502/503/504 upstream errors", () => {
    for (const status of [502, 503, 504]) {
      expect(mailRetry(0, new MailApiError(status, "stalwart_unavailable"))).toBe(true);
      expect(mailRetry(1, new MailApiError(status, "stalwart_unavailable"))).toBe(true);
      expect(mailRetry(2, new MailApiError(status, "stalwart_unavailable"))).toBe(false);
    }
  });

  it("returns false for a 404 MailApiError", () => {
    expect(mailRetry(0, new MailApiError(404, "not_found"))).toBe(false);
  });

  it("keeps the default 3-retry cap for a 5xx outside the bounded-retry set (e.g. 500 internal)", () => {
    expect(mailRetry(2, new MailApiError(500, "internal"))).toBe(true);
    expect(mailRetry(3, new MailApiError(500, "internal"))).toBe(false);
  });

  it("returns true (below the retry cap) for a plain network Error", () => {
    expect(mailRetry(0, new Error("network down"))).toBe(true);
    expect(mailRetry(2, new Error("network down"))).toBe(true);
    expect(mailRetry(3, new Error("network down"))).toBe(false);
  });
});

describe("mailRetryDelay", () => {
  it("grows with each attempt but stays short and bounded", () => {
    const first = mailRetryDelay(0);
    const second = mailRetryDelay(1);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(400);
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
