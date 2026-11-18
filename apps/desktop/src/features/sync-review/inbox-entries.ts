import { useCallback, useEffect, useState } from "react";
import {
  syncReview,
  type ConflictSummary,
  type Notice,
} from "@/lib/sync-review-api";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { fieldList } from "./labels";

/** What sync puts in the Inbox: a conflict to review, or a notice needing no decision. */
export type SyncEntry = {
  /** The id its read state is kept under. */
  id: string;
  reference: string | null;
  title: string;
  summary: string;
  timestamp: string;
  read: boolean;
  /** Present on a conflict: opening the entry opens its comparison. */
  conflict?: ConflictSummary;
  icon: "review" | "dependency" | "file";
  /**
   * A notice about a Drive file: its summary names a path and wraps rather
   * than being cut off.
   */
  file?: true;
};

function fromConflict(conflict: ConflictSummary): SyncEntry {
  return {
    id: conflict.id,
    reference: conflict.reference,
    title: conflict.title,
    summary: `Needs review · ${fieldList(conflict.kind, conflict.fields)} changed on two desktops`,
    timestamp: conflict.detected_at,
    read: conflict.read,
    conflict,
    icon: "review",
  };
}

type FileNotice = Extract<
  Notice,
  { kind: "unreadable_file" | "replaced_file" | "oversized_record" }
>;

const fileSummary: Record<
  FileNotice["kind"],
  [string, (n: FileNotice) => string]
> = {
  unreadable_file: [
    "A Drive file could not be read",
    (n) => `${n.path} was skipped · ${n.reason}`,
  ],
  replaced_file: [
    "A Drive file was replaced",
    (n) =>
      `${n.path} could not be read and was replaced by this desktop's version · ${n.reason} · the earlier file is in Drive's version history`,
  ],
  oversized_record: [
    "A record is too large to sync",
    (n) => `${n.path} was not uploaded · ${n.reason} · shorten it to sync it`,
  ],
};

/** A file notice opens the Ticket it belongs to when that Ticket is here. */
function fromFileNotice(notice: FileNotice): SyncEntry {
  const [title, summary] = fileSummary[notice.kind];
  return {
    id: notice.id,
    timestamp: notice.timestamp,
    read: notice.read,
    reference: notice.ticket_reference ?? null,
    title,
    summary: summary(notice),
    icon: "file",
    file: true,
  };
}

function fromNotice(notice: Notice): SyncEntry {
  const { id, timestamp, read } = notice;
  if (
    notice.kind === "unreadable_file" ||
    notice.kind === "replaced_file" ||
    notice.kind === "oversized_record"
  )
    return fromFileNotice(notice);
  if (notice.kind === "parent_removed")
    return {
      id,
      timestamp,
      read,
      reference: notice.reference,
      title: notice.title,
      summary: `Sync removed parent ${notice.other} · it would have made a loop`,
      icon: "dependency",
    };
  return {
    id,
    timestamp,
    read,
    reference: notice.reference,
    title: notice.title,
    summary: `Sync removed “${notice.relation === "blocks" ? "blocks" : "blocked by"} ${notice.other}” · it would have made a loop`,
    icon: "dependency",
  };
}

/**
 * Sync's Inbox entries, newest first, refreshed whenever the Workspace changes
 * or `revision` moves. A Workspace without sync has none.
 */
export function useSyncEntries(revision: number): {
  entries: SyncEntry[];
  reload: () => void;
} {
  const [entries, setEntries] = useState<SyncEntry[]>([]);
  const [tick, setTick] = useState(0);
  const change = useWorkspaceChange();
  useEffect(() => {
    let active = true;
    Promise.all([syncReview.conflicts(), syncReview.notices()]).then(
      ([conflicts, notices]) => {
        if (!active) return;
        setEntries(
          [...conflicts.map(fromConflict), ...notices.map(fromNotice)].sort(
            (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
          ),
        );
      },
      () => {
        if (active) setEntries([]);
      },
    );
    return () => {
      active = false;
    };
  }, [change, tick, revision]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { entries, reload };
}

/**
 * Places sync's entries among the Inbox's own by time. The Inbox's order is the
 * core's and is kept; each sync entry goes before the first entry older than it.
 */
export function mergeByTime<T extends { timestamp: string }>(
  entries: T[],
  sync: SyncEntry[],
): (T | SyncEntry)[] {
  // ponytail: sync entries older than the last loaded page still show at its
  // end; page them with the Inbox if their number ever grows.
  const merged: (T | SyncEntry)[] = [];
  let next = 0;
  for (const entry of entries) {
    const time = Date.parse(entry.timestamp);
    for (
      let item = sync[next];
      item && Date.parse(item.timestamp) > time;
      item = sync[++next]
    )
      merged.push(item);
    merged.push(entry);
  }
  return [...merged, ...sync.slice(next)];
}
