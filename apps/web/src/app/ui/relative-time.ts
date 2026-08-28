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
  // Formatted by hand instead of toLocaleTimeString: ICU builds disagree on
  // zero-padding "numeric" hours across platforms, and the design fixes the
  // shape to H:mm regardless of locale.
  if (dayDiff <= 0) {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (dayDiff === 1) {
    return options.yesterdayLabel;
  }
  // #348: a bare "13 jul" is ambiguous once the email is over a year old —
  // it reads as if it just happened. Only add the year when it differs from
  // `now`'s, so a same-year older date stays as short as before.
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleDateString(options.locale, {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

/**
 * The full date and time formatRelativeTime's compact label leaves out —
 * meant for a `title` attribute (or similar) so the exact moment is still
 * available on demand, not just the skimmable "10:12"/"Ayer"/"13 jul" label.
 * Returns "" for an unparsable input, matching formatRelativeTime.
 */
export function formatAbsoluteDateTime(
  input: string | Date,
  options: { locale?: string } = {},
): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString(options.locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
