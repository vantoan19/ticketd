/*
 * The one time and count module (DESIGN.md section 12, proposal P17). Every
 * count, plural, "N of M" and time in the interface comes from here, so the
 * same thing always reads the same way:
 *
 * - `plural(3, "ticket")` → "3 tickets"; `noun(1, "ticket")` → "ticket".
 * - `ofTotal(3, 12)` → "3 of 12", only for filtered-of-total.
 * - `compactAgo` for trailing columns ("4h", "2d", then "Nov 2").
 * - `relativeDateTime` for sentences ("5 h ago", then "Nov 2").
 * - `formatTime` for clock times in transcripts (OS locale, 12/24h).
 * - `formatDateTime` for the exact local time in a tooltip.
 * - `listTime` for a list row's time: "23:43", "Mon", "25 Nov", then "25 Nov 2025".
 */

/** The noun for a count: "ticket" for 1, "tickets" otherwise. */
export function noun(count: number, singular: string, pluralForm?: string) {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** A count and its noun: "1 comment", "3 comments", "0 files". */
export function plural(
  count: number,
  singular: string,
  pluralForm?: string,
): string {
  return `${count} ${noun(count, singular, pluralForm)}`;
}

/** Filtered of total: "3 of 12". Only where a filter narrows a known total. */
export function ofTotal(shown: number, total: number): string {
  return `${shown} of ${total}`;
}

/** Locale date and time for a stored timestamp, or the raw value if it is not a date. */
export function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

/** Locale time of day for a date, such as 9:00 AM or 09:00. */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Midnight at the start of the date's local day, in milliseconds. */
export function startOfLocalDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** "Nov 2", with the year only when it is not this year. */
function shortDate(then: Date, now: number): string {
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}

/** Reading time for sentences: "5 h ago"; a calendar date after a week. */
export function relativeDateTime(timestamp: string, now = Date.now()): string {
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return timestamp;
  const minutes = Math.max(0, Math.floor((now - then.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} d ago`;
  return shortDate(then, now);
}

/** Shortest reading age for trailing columns: "now", "2m", "1h", "3d", then "Nov 2". */
export function compactAgo(timestamp: string, now = Date.now()): string | null {
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return null;
  const minutes = Math.max(0, Math.floor((now - then.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return shortDate(then, now);
}

const DAY = 86_400_000;

/**
 * The time a list row shows, by calendar day: the time of day today, a weekday for the
 * six days before, the day and month this year, and the full date before that.
 */
export function listTime(
  timestamp: string,
  now = Date.now(),
  locale?: string,
): string | null {
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.round(
    (startOfLocalDay(new Date(now)) - startOfLocalDay(then)) / DAY,
  );
  if (days === 0)
    return then.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
  if (days > 0 && days < 7)
    return then.toLocaleDateString(locale, { weekday: "short" });
  return then.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}
