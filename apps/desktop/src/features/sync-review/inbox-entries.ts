import { useCallback, useEffect, useState } from "react";
import {
  syncReview,
  type ConflictSummary,
  type Notice,
} from "@/lib/sync-review-api";
import type { SyncProvider } from "@/lib/sync-api";
import { useSyncStatus } from "@/features/sync/sync-status";
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
   * A notice about a file in the sync storage: its summary names a path and wraps rather
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

/** How a file notice names the stored file and where its earlier versions are kept. */
const FILE_WORDS: Record<
  SyncProvider,
  { unreadable: string; replaced: string; history: string }
> = {
  google_drive: {
    unreadable: "A Drive file could not be read",
    replaced: "A Drive file was replaced",
    history: "the earlier file is in Drive's version history",
  },
  s3: {
    unreadable: "An S3 object could not be read",
    replaced: "An S3 object was replaced",
    history: "the earlier object is in the bucket's version history",
  },
};

/** A file notice opens the Ticket it belongs to when that Ticket is here. */
function fromFileNotice(
  notice: FileNotice,
  provider: SyncProvider | undefined,
): SyncEntry {
  const words = FILE_WORDS[provider ?? "google_drive"];
  const [title, summary] =
    notice.kind === "unreadable_file"
      ? [words.unreadable, `${notice.path} was skipped · ${notice.reason}`]
      : notice.kind === "replaced_file"
        ? [
            words.replaced,
            `${notice.path} could not be read and was replaced by this desktop's version · ${notice.reason} · ${words.history}`,
          ]
        : [
            "A record is too large to sync",
            `${notice.path} was not uploaded · ${notice.reason} · shorten it to sync it`,
          ];
  return {
    id: notice.id,
    timestamp: notice.timestamp,
    read: notice.read,
    reference: notice.ticket_reference ?? null,
    title,
    summary,
    icon: "file",
    file: true,
  };
}

function fromNotice(
  notice: Notice,
  provider: SyncProvider | undefined,
): SyncEntry {
  const { id, timestamp, read } = notice;
  if (
    notice.kind === "unreadable_file" ||
    notice.kind === "replaced_file" ||
    notice.kind === "oversized_record"
  )
    return fromFileNotice(notice, provider);
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
  const provider = useSyncStatus().status?.provider;
  useEffect(() => {
    let active = true;
    Promise.all([syncReview.conflicts(), syncReview.notices()]).then(
      ([conflicts, notices]) => {
        if (!active) return;
        setEntries(
          [
            ...conflicts.map(fromConflict),
            ...notices.map((notice) => fromNotice(notice, provider)),
          ].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
        );
      },
      () => {
        if (active) setEntries([]);
      },
    );
    return () => {
      active = false;
    };
  }, [change, tick, revision, provider]);
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
