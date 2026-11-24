import type { Entry as HistoryEntry } from "@/lib/api/history";
import { startOfLocalDay } from "@/lib/format";
import { describeChange } from "./history-sentence";
import { providerName, type SourceEntry } from "@/lib/api/sources";
import { progressBrief } from "./progress-brief";
export type { Entry } from "@/lib/api/inbox";
import type { Entry } from "@/lib/api/inbox";
import type { Ticket } from "@/lib/api/client";

/**
 * Why the Ticket an Inbox entry names cannot be changed, or null when it can:
 * `undefined` is a Ticket not read yet, `null` one the core says is gone.
 * A reminder is the person's own and does not change the Ticket, so
 * `allowTrashed` lets a Ticket in Trash keep one (spec 4.6; the core allows it).
 */
export function ticketUnavailable(
  record: Ticket | null | undefined,
  { allowTrashed = false }: { allowTrashed?: boolean } = {},
): string | null {
  if (record === undefined) return "The Ticket is still loading.";
  if (record === null) return "The Ticket no longer exists.";
  return record.trashed && !allowTrashed
    ? "Restore the Ticket to reply or change it."
    : null;
}

export type DayGroup = "Today" | "Yesterday" | "Earlier";

/** What kind of thing happened, in words suitable for an accessible name. */
export function entryNoun(entry: Entry): string {
  if (entry.kind === "reminder") return "reminder";
  if (entry.kind === "activity") return "update";
  if (entry.kind === "automation_run") return "run";
  return "change";
}

/** A plain-language summary. Internal event keys never appear in it. */
export function summarize(
  entry: Entry,
  sources: readonly SourceEntry[] = [],
): string {
  // A run that needs attention: its Automation, then why.
  if (entry.kind === "automation_run")
    return `${entry.editing_agent ?? "An Automation"} needs attention${
      entry.to_value && `: ${entry.to_value}`
    }`;
  const base =
    entry.kind === "reminder"
      ? "Your reminder is due"
      : entry.kind === "activity"
        ? entry.deleted
          ? "Update deleted"
          : `New update: ${progressBrief(entry.to_value)}`
        : describeChange(entry.kind, entry.from_value, entry.to_value, {
            project: () => undefined,
            plan: () => undefined,
            source: (id) => providerName(id, sources),
          });
  return entry.editing_agent
    ? `${base} · ${providerName(entry.editing_agent, sources)}`
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
  { value: "hour", label: "In 1 hour" },
  { value: "tomorrow", label: "Tomorrow" },
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

export type AttentionContext = {
  statuses: ReadonlyMap<string, string>;
  /** Explicit device-local Undo restores one original review against an exact host transition. */
  restoredReviews?: ReadonlyMap<number, HistoryEntry>;
  reminders: ReadonlyMap<string, string | null>;
  latestStatusChanges: ReadonlyMap<string, HistoryEntry>;
};
export type AttentionGroup = "Needs you" | "Updates" | "Earlier";

/** Attribution names an agent only when supplied; absence never establishes a human. */
export function needsYou(
  entry: Entry,
  context: AttentionContext,
  now: Date,
): boolean {
  if (entry.kind === "status") {
    // Local changes stay in history even when they do not notify the Inbox.
    // An old review must not become urgent again in a later review cycle.
    const latest = context.latestStatusChanges.get(entry.reference);
    return (
      entry.to_value === "In review" &&
      entry.editing_agent !== null &&
      entry.editing_agent !== "local-person" &&
      context.statuses.get(entry.reference) === "In review" &&
      latest?.to_value === "In review" &&
      ((latest.editing_agent === entry.editing_agent &&
        new Date(entry.timestamp).getTime() >=
          new Date(latest.timestamp).getTime()) ||
        (!!context.restoredReviews?.get(entry.id) &&
          sameTransition(latest, context.restoredReviews.get(entry.id)!)))
    );
  }
  if (entry.kind === "reminder") {
    const due = context.reminders.get(entry.reference);
    return (
      !!due &&
      due === entry.to_value &&
      new Date(due).getTime() <= now.getTime()
    );
  }
  return false;
}

export function attentionGroup(
  entry: { read: boolean; timestamp: string },
  now: Date,
): AttentionGroup {
  return entry.read && dayGroup(entry.timestamp, now) !== "Today"
    ? "Earlier"
    : "Updates";
}

export function approvalChats<
  T extends { status: { rank: string }; tickets: { reference: string }[] },
>(chats: T[]): T[] {
  return chats.filter((chat) => chat.status.rank === "approval");
}

/** Exact host transition identity for an explicitly restored review, without rewriting attribution. */
export function sameTransition(first: HistoryEntry, second: HistoryEntry) {
  return (
    first.kind === second.kind &&
    first.from_value === second.from_value &&
    first.to_value === second.to_value &&
    first.timestamp === second.timestamp &&
    first.editing_agent === second.editing_agent
  );
}
