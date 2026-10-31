import type { Entry } from "@/lib/api/history";

type Lookups = {
  /** Resolve a Project or Effort id to its name; unknown ids fall through. */
  project: (id: string) => string | undefined;
  effort: (id: string) => string | undefined;
};

const quote = (value: string) => `“${value}”`;

const noLookups: Lookups = {
  project: () => undefined,
  effort: () => undefined,
};

/** Plain-language sentence for one recorded change, never an event key. */
export function historySentence(entry: Entry, lookups: Lookups): string {
  return describeChange(entry.kind, entry.from_value, entry.to_value, lookups);
}

/**
 * The one place that words a change of `kind` from one value to another. The
 * ticket's Activity and the Inbox both read it, so they never disagree.
 */
export function describeChange(
  kind: string,
  from: string,
  to: string,
  lookups: Lookups = noLookups,
): string {
  const addedOrRemoved = (added: string, removed: string) =>
    to ? `${added} ${to}` : `${removed} ${from}`;
  switch (kind) {
    case "status":
      return `Status changed from ${from} to ${to}`;
    case "project": {
      const name = (id: string) => lookups.project(id) ?? id;
      return from && to
        ? `Project changed from ${name(from)} to ${name(to)}`
        : to
          ? `Added to project ${name(to)}`
          : `Removed from project ${name(from)}`;
    }
    case "effort": {
      const name = (id: string) => lookups.effort(id) ?? id;
      return from && to
        ? `Effort changed from ${name(from)} to ${name(to)}`
        : to
          ? `Effort set to ${name(to)}`
          : "Effort cleared";
    }
    case "parent":
      return from && to
        ? `Parent changed from ${from} to ${to}`
        : to
          ? `Parent set to ${to}`
          : `Removed from parent ${from}`;
    case "dependency":
      return addedOrRemoved("Now blocked by", "No longer blocked by");
    case "relationship:child":
      return addedOrRemoved("Added subticket", "Removed subticket");
    case "relationship:blocks":
      return addedOrRemoved("Now blocks", "No longer blocks");
    case "relationship:related":
      return addedOrRemoved("Linked as related to", "Unlinked from related");
    case "relationship:discovery":
      return to
        ? `Discovered ${to} while working on this`
        : `No longer marked as discovering ${from}`;
    case "relationship:discovered-while":
      return addedOrRemoved(
        "Discovered while working on",
        "No longer marked as discovered while working on",
      );
    case "relationship:duplicate":
      return from && to
        ? `Duplicate of changed from ${from} to ${to}`
        : to
          ? `Marked as duplicate of ${to}`
          : `No longer a duplicate of ${from}`;
    case "evidence":
      return !from
        ? `Added evidence ${quote(to)}`
        : !to
          ? `Removed evidence ${quote(from)}`
          : from === to
            ? `Updated evidence ${quote(to)}`
            : `Renamed evidence ${quote(from)} to ${quote(to)}`;
    case "trash":
      return to === "trashed" ? "Moved to trash" : "Restored from trash";
    default:
      return "Ticket updated";
  }
}
