import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./relative-time";

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
