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

/** Compact reading time; a calendar date after a week, with exact time available in a tooltip. */
export function relativeDateTime(timestamp: string, now = Date.now()): string {
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return timestamp;
  const minutes = Math.max(0, Math.floor((now - then.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} d ago`;
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}

/** Shortest reading age for dense lists: "now", "2m", "1h", "3d", "2w". */
export function compactAgo(timestamp: string, now = Date.now()): string | null {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}
