import { startOfLocalDay } from "@/lib/format";
export type { Entry } from "@/lib/api/inbox";
import type { Entry } from "@/lib/api/inbox";

export type DayGroup = "Today" | "Yesterday" | "Earlier";

/** What kind of thing happened, in words suitable for an accessible name. */
export function entryNoun(entry: Entry): string {
  if (entry.kind === "reminder") return "reminder";
  if (entry.kind === "note") return "note";
  return "change";
}

/** A plain-language summary. Internal event keys never appear in it. */
export function summarize(entry: Entry): string {
  const added = entry.to_value !== "";
  const target = entry.to_value || entry.from_value;
  const base = (() => {
    switch (entry.kind) {
      case "reminder":
        return "Your reminder is due";
      case "note":
        return `New note: ${entry.to_value}`;
      case "status":
        return `Status changed from ${entry.from_value} to ${entry.to_value}`;
      case "parent":
        return added ? `Parent set to ${target}` : `Parent ${target} removed`;
      case "dependency":
        return added
          ? `Now blocked by ${target}`
          : `No longer blocked by ${target}`;
      case "relationship:blocks":
        return added ? `Now blocks ${target}` : `No longer blocks ${target}`;
      case "relationship:related":
        return added
          ? `Related to ${target}`
          : `No longer related to ${target}`;
      case "relationship:discovery":
        return added
          ? `Discovered ${target} while working on this`
          : `Discovery link to ${target} removed`;
      case "relationship:discovered-while":
        return added
          ? `Discovered while working on ${target}`
          : `Discovery source ${target} removed`;
      case "relationship:duplicate":
        return added
          ? `Marked as a duplicate of ${target} and canceled`
          : `No longer marked as a duplicate of ${target}`;
      default:
        return "A relationship changed";
    }
  })();
  return entry.editing_agent ? `${base} · ${entry.editing_agent}` : base;
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

export function groupEntries(
  entries: Entry[],
  now: Date,
): { group: DayGroup; entries: Entry[] }[] {
  const groups: { group: DayGroup; entries: Entry[] }[] = [];
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
