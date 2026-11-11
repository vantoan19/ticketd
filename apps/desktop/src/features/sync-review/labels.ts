import { formatTime, startOfLocalDay } from "@/lib/format";
import type { RecordKind } from "@/lib/sync-review-api";

/** The body of a ticket is its Description; a Document's is its Text. */
export function fieldLabel(kind: RecordKind, field: string): string {
  if (field === "body") return kind === "ticket" ? "Description" : "Text";
  const words = field.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Status and Description", "Title, Status and Description". */
export function fieldList(kind: RecordKind, fields: string[]): string {
  const names = fields.map((field) => fieldLabel(kind, field));
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Today, Yesterday, or the calendar date of a timestamp's local day. */
export function dayLabel(timestamp: string, now: Date): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const today = startOfLocalDay(now);
  const day = startOfLocalDay(date);
  if (day === today) return "Today";
  if (day === startOfLocalDay(new Date(today - 1))) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Today at 6:31 PM". */
export function dayTime(timestamp: string, now: Date): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return `${dayLabel(timestamp, now)} at ${formatTime(date)}`;
}
