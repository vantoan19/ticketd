import { startOfLocalDay } from "@/lib/format";
import { describeChange } from "./history-sentence";
import { providerName } from "./ticket-source";
export type { Entry } from "@/lib/api/inbox";
import type { Entry } from "@/lib/api/inbox";

export type DayGroup = "Today" | "Yesterday" | "Earlier";

/** What kind of thing happened, in words suitable for an accessible name. */
export function entryNoun(entry: Entry): string {
  if (entry.kind === "reminder") return "reminder";
  if (entry.kind === "activity") return "update";
  return "change";
}

/** A plain-language summary. Internal event keys never appear in it. */
export function summarize(entry: Entry): string {
  const base =
    entry.kind === "reminder"
      ? "Your reminder is due"
      : entry.kind === "activity"
        ? entry.deleted
          ? "Update deleted"
          : `New update: ${entry.to_value}`
        : describeChange(entry.kind, entry.from_value, entry.to_value);
  return entry.editing_agent
    ? `${base} · ${providerName(entry.editing_agent)}`
    : base;
}

/** Group by local calendar day relative to `now`. */
export function dayGroup(timestamp: string, now: Date): DayGroup {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = startOfLocalDay(now);
  const day = startOfLocalDay(date);
  if (day >= today) return "Today";
  const yesterday = startOfLocalDay(new Date(today - 1));
  return day >= yesterday ? "Yesterday" : "Earlier";
}

export function groupEntries<T extends { timestamp: string }>(
  entries: T[],
  now: Date,
): { group: DayGroup; entries: T[] }[] {
  const groups: { group: DayGroup; entries: T[] }[] = [];
  for (const entry of entries) {
    const group = dayGroup(entry.timestamp, now);
    const last = groups[groups.length - 1];
    if (last?.group === group) last.entries.push(entry);
    else groups.push({ group, entries: [entry] });
  }
  return groups;
}

/** Time of day for today and yesterday, the date for anything older. */
export function entryTime(timestamp: string, group: DayGroup): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return group === "Earlier"
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
}

export type SnoozeChoice = "hour" | "tomorrow";

export const snoozeChoices: { value: SnoozeChoice; label: string }[] = [
  { value: "hour", label: "In one hour" },
  { value: "tomorrow", label: "Tomorrow morning" },
];

/** The instant a snooze choice resolves to; tomorrow morning is 9:00 local time. */
export function snoozeInstant(choice: SnoozeChoice, now: Date): string {
  if (choice === "hour") return new Date(now.getTime() + 3600000).toISOString();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    9,
    0,
  ).toISOString();
}
