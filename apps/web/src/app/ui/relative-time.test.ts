import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAbsoluteDateTime, formatRelativeTime } from "./relative-time";

const YESTERDAY_LABEL = "Ayer";

describe("formatRelativeTime", () => {
  it("formats a same-day timestamp as a local HH:mm time", () => {
    const now = new Date(2026, 6, 21, 14, 0, 0);
    const date = new Date(2026, 6, 21, 10, 12, 0);

    expect(formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL })).toBe("10:12");
  });

  it("does not zero-pad a single-digit hour", () => {
    const now = new Date(2026, 6, 21, 14, 0, 0);
    const date = new Date(2026, 6, 21, 9, 42, 0);

    expect(formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL })).toBe("9:42");
  });

  it("returns the yesterday label for a timestamp from the previous calendar day", () => {
    const now = new Date(2026, 6, 21, 8, 0, 0);
    const date = new Date(2026, 6, 20, 23, 55, 0);

    expect(formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL })).toBe(YESTERDAY_LABEL);
  });

  it("treats a same-day timestamp just after midnight as today, not yesterday", () => {
    const now = new Date(2026, 6, 21, 0, 5, 0);
    const date = new Date(2026, 6, 21, 0, 1, 0);

    expect(formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL })).toBe("0:01");
  });

  it("returns a short date for anything older than yesterday", () => {
    const now = new Date(2026, 6, 21, 12, 0, 0);
    const date = new Date(2026, 6, 13, 9, 0, 0);

    const result = formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL, locale: "en-US" });

    expect(result).not.toBe(YESTERDAY_LABEL);
    expect(result).not.toMatch(/^\d{1,2}:\d{2}$/);
    expect(result).toContain("13");
  });

  // #348: a short date with no year is ambiguous once the email is over a
  // year old — "13 jul" from last year reads as if it just happened.
  it("includes the year for a timestamp from a different calendar year than `now`", () => {
    const now = new Date(2026, 6, 21, 12, 0, 0);
    const date = new Date(2024, 6, 13, 9, 0, 0);

    const result = formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL, locale: "en-US" });

    expect(result).toContain("2024");
  });

  it("omits the year for an older date still within the same calendar year", () => {
    const now = new Date(2026, 6, 21, 12, 0, 0);
    const date = new Date(2026, 0, 13, 9, 0, 0);

    const result = formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL, locale: "en-US" });

    expect(result).not.toContain("2026");
  });

  it("accepts an ISO string as well as a Date", () => {
    const now = new Date(2026, 6, 21, 14, 0, 0);

    expect(
      formatRelativeTime("2026-07-21T10:12:00", { now, yesterdayLabel: YESTERDAY_LABEL }),
    ).toBe("10:12");
  });

  it("returns an empty string for an invalid date", () => {
    const now = new Date(2026, 6, 21, 14, 0, 0);

    expect(formatRelativeTime("not-a-date", { now, yesterdayLabel: YESTERDAY_LABEL })).toBe("");
  });

  it("treats a future timestamp (clock skew) as today rather than throwing or misformatting", () => {
    const now = new Date(2026, 6, 21, 10, 0, 0);
    const date = new Date(2026, 6, 21, 10, 30, 0);

    expect(formatRelativeTime(date, { now, yesterdayLabel: YESTERDAY_LABEL })).toBe("10:30");
  });

  describe("with fake timers (default `now`)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 21, 16, 30, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("defaults `now` to the current system time when not provided", () => {
      const date = new Date(2026, 6, 21, 16, 5, 0);

      expect(formatRelativeTime(date, { yesterdayLabel: YESTERDAY_LABEL })).toBe("16:05");
    });

    it("still resolves yesterday relative to the faked system time", () => {
      const date = new Date(2026, 6, 20, 22, 0, 0);

      expect(formatRelativeTime(date, { yesterdayLabel: YESTERDAY_LABEL })).toBe(YESTERDAY_LABEL);
    });
  });
});

// #348: formatRelativeTime's compact label ("10:12", "Ayer", "13 jul") is
// meant to be skimmed, not to name a moment precisely — the reader needs the
// full date and time available too, as a `title` attribute a keyboard/mouse
// user can inspect, and a screen reader can announce.
describe("formatAbsoluteDateTime", () => {
  it("includes the full date and time", () => {
    const date = new Date(2026, 6, 21, 10, 12, 0);

    const result = formatAbsoluteDateTime(date, { locale: "en-US" });

    expect(result).toContain("2026");
    expect(result).toMatch(/10:12/);
  });

  it("accepts an ISO string as well as a Date", () => {
    const result = formatAbsoluteDateTime("2026-07-21T10:12:00", { locale: "en-US" });

    expect(result).toContain("2026");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatAbsoluteDateTime("not-a-date", { locale: "en-US" })).toBe("");
  });
});
