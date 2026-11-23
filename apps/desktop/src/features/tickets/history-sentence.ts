import type { Entry } from "@/lib/api/history";

type Lookups = {
  /** Resolve a Project or Plan id to its name; unknown ids fall through. */
  project: (id: string) => string | undefined;
  plan: (id: string) => string | undefined;
  source?: (id: string) => string;
};

const quote = (value: string) => `“${value}”`;

const noLookups: Lookups = {
  project: () => undefined,
  plan: () => undefined,
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
      return `Status ${from} → ${to}`;
    case "project": {
      const name = (id: string) => lookups.project(id) ?? id;
      return from && to
        ? `Project changed from ${name(from)} to ${name(to)}`
        : to
          ? `Project set to ${name(to)}`
          : `Removed from project ${name(from)}`;
    }
    case "plan": {
      const name = (id: string) => lookups.plan(id) ?? id;
      return from && to
        ? `Plan changed from ${name(from)} to ${name(to)}`
        : to
          ? `Plan set to ${name(to)}`
          : "Plan cleared";
    }
    case "parent":
      return from && to
        ? `Parent changed from ${from} to ${to}`
        : to
          ? `Parent set to ${to}`
          : `Removed from parent ${from}`;
    case "dependency":
      return addedOrRemoved("Blocked by", "No longer blocked by");
    case "tag":
      return addedOrRemoved("Added tag", "Removed tag");
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
    case "external_duplicate":
      return from && to
        ? `Its source now names ${to} as the original, not ${from}`
        : to
          ? `Its source named ${to} as the original`
          : `Its source no longer names ${from} as the original`;
    case "source_import":
      return `Imported from ${to}${from ? ` as ${from}` : ""}`;
    case "source_unavailable":
      return `Source unavailable (${to.replaceAll("_", " ")})`;
    case "publication_unresolved":
      return `Publish to ${to} — no response, outcome unknown`;
    case "publication":
      return to === "not created"
        ? "Confirmed that nothing was created by the earlier publication attempt"
        : "Publication attempt updated";
    case "ownership":
      return `Took ownership from ${lookups.source?.(from) ?? from}; the ticket is now local`;
    case "source":
      return from === "attached"
        ? `Linked to ${to} after an uncertain publication`
        : `Published to ${to}`;
    case "sync_dependency_removed":
      // `from` is the other ticket; `to` says which way the dropped edge ran.
      return `Sync removed ${quote(`${to === "blocks" ? "blocks" : "blocked by"} ${from}`)}; it would have made a loop`;
    case "sync_parent_removed":
      // `from` is the other ticket; `to` says what it was to this one.
      return `Sync removed ${quote(`${to === "child" ? "subticket" : "parent"} ${from}`)}; it would have made a loop`;
    case "trash":
      return to === "trashed" ? "Moved to Trash" : "Restored from Trash";
    default:
      return "Ticket updated";
  }
}

/** Kinds whose additions made together read as one change. */
const groupedKinds = new Set(["evidence", "relationship:child"]);

/** Whether an entry only adds a value, so it can share a row with its siblings. */
export function isAddition(entry: Entry): boolean {
  return groupedKinds.has(entry.kind) && !entry.from_value && !!entry.to_value;
}

/** One sentence for several additions of one kind made together. */
export function describeAdditions(kind: string, values: string[]): string {
  const named = kind === "evidence" ? values.map(quote) : values;
  const list =
    named.length < 2
      ? named.join("")
      : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return kind === "evidence"
    ? `Added evidence ${list}`
    : `Added subtickets ${list}`;
}

/** A compact inventory of actual records; full values and attribution expand below. */
export function changeSummary(changes: Entry[]): string {
  const counts = new Map<string, number>();
  for (const entry of changes) {
    const kind =
      entry.kind === "dependency" ||
      entry.kind === "parent" ||
      entry.kind.startsWith("relationship:") ||
      entry.kind.startsWith("sync_")
        ? "link"
        : entry.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, count]) => {
    if (kind === "evidence")
      return `${count} ${count === 1 ? "piece" : "pieces"} of evidence`;
    if (kind === "link") return `${count} ${count === 1 ? "link" : "links"}`;
    if (kind === "status")
      return `status to ${changes.find((entry) => entry.kind === "status")?.to_value}`;
    if (kind === "plan") return "Plan";
    if (kind === "project") return "project";
    if (kind === "tag") return `${count} ${count === 1 ? "tag" : "tags"}`;
    if (kind === "trash")
      return changes.find((entry) => entry.kind === "trash")?.to_value ===
        "trashed"
        ? "moved to Trash"
        : "restored from Trash";
    if (kind === "ownership") return "ownership";
    if (kind === "external_duplicate") return "duplicate";
    if (kind.startsWith("source") || kind.startsWith("publication"))
      return "source";
    return `${count} ${count === 1 ? "other change" : "other changes"}`;
  });
  return `${changes.length} ${changes.length === 1 ? "change" : "changes"}: ${parts.join(", ")}`;
}
