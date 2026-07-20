// docs/design/cefiro/README.md — list/reader time display: same calendar day
// -> local "10:12" style time, previous calendar day -> a localized
// "Yesterday" label, anything older -> a short date. All day-boundary math
// uses local time (not UTC) so the bucketing matches what the user sees on
// their own clock.

export interface RelativeTimeOptions {
  /** Reference "now" instant. Defaults to `new Date()` — pass an explicit
   * value in tests for determinism. */
  now?: Date;
  /** BCP 47 locale for the time-of-day and short-date Intl formatting. */
  locale?: string;
  /** Localized label shown for timestamps that fall on the previous calendar day. */
  yesterdayLabel: string;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Formats a timestamp the way the Céfiro list/reader show it: "10:12" for
 * today, `yesterdayLabel` for yesterday, and a short localized date for
 * anything older. Returns "" for an unparsable input.
 */
export function formatRelativeTime(input: string | Date, options: RelativeTimeOptions): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";

  const now = options.now ?? new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  // dayDiff <= 0 covers both "today" and any future timestamp (clock skew
  // between client/server) — both read most sensibly as a plain time.
  if (dayDiff <= 0) {
    return date.toLocaleTimeString(options.locale, { hour: "numeric", minute: "2-digit", hour12: false });
  }
  if (dayDiff === 1) {
    return options.yesterdayLabel;
  }
  return date.toLocaleDateString(options.locale, { day: "numeric", month: "short" });
}
