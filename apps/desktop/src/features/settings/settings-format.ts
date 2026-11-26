import type { FailureDescription } from "@/lib/api/describe-failure";

/**
 * A failure a helper already put in one line, such as revealFile's
 * "Couldn't show the file in Finder. It was moved.", as an Alert's title and
 * sentence. It carries no raw text, so it has no Details.
 */
export function lineFailure(text: string): FailureDescription {
  const cut = text.indexOf(". ");
  return {
    code: "failed",
    title: (cut < 0 ? text : text.slice(0, cut)).replace(/\.$/, ""),
    sentence: cut < 0 ? "" : text.slice(cut + 2),
    action: null,
    details: "",
  };
}

/** Today's date as YYYY-MM-DD in local time, for suggested file names. */
export function localDate() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A file path as its folder and file name, for either kind of separator. */
export function splitPath(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0
    ? { folder: "", name: path }
    : {
        folder: path.slice(0, cut) || path.slice(0, 1),
        name: path.slice(cut + 1),
      };
}

const DAY = 86_400_000;

/** The time of day in the person's own format, such as 08:52 or 8:52 AM. */
function clock(date: Date) {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * When a restore point was saved, by calendar day: "Today, 08:52", "Yesterday, 17:40", then
 * the weekday and date ("Fri 21 Nov, 08:52", with the year for an earlier year).
 */
export function restorePointWhen(savedAt: string, now = new Date()): string {
  const then = new Date(savedAt);
  if (Number.isNaN(then.getTime())) return savedAt;
  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(then)) / DAY);
  if (days === 0) return `Today, ${clock(then)}`;
  if (days === 1) return `Yesterday, ${clock(then)}`;
  const date = then.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(then.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${clock(then)}`;
}

/** A day on its own, for "back to Friday 21 Nov". */
export function restorePointDay(savedAt: string): string {
  const then = new Date(savedAt);
  if (Number.isNaN(then.getTime())) return savedAt;
  return then.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

/** A size in bytes as "1.2 GB", for the footer past the gigabyte it is shown from. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
