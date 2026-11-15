import { useCallback, useEffect, useState } from "react";
import { syncReview, type Availability } from "@/lib/sync-review-api";
import { useWorkspaceChange } from "@/lib/workspace-change";

const POLL_MS = 2000;

/**
 * Where a managed Attachment's file is, in the app's storage words (set
 * CO-16): "On this computer", or "Not downloaded" while its bytes are only in
 * Google Drive, so it never reads like a Drive reference ("Google Drive").
 * Without sync every file is local.
 */
export function storageWord(availability: Availability | undefined): string {
  if (availability?.state === "downloading") return "Downloading…";
  if (availability?.state === "not_downloaded") return "Not downloaded";
  return "On this computer";
}

/**
 * Whether the bytes of the named managed Attachments are on this desktop,
 * keyed by id, and the action that fetches one. It follows Workspace changes
 * and, while a file is downloading, asks again every two seconds.
 */
export function useAvailability(ids: string[]): {
  of: (id: string) => Availability | undefined;
  download: (id: string) => Promise<void>;
  /** The first read for these files has answered (or failed), so `of` can be trusted. */
  known: boolean;
} {
  const key = ids.join("\n");
  const [found, setFound] = useState<Availability[]>([]);
  const [answered, setAnswered] = useState<string | null>(null);
  // Downloads this view asked for that have not answered yet.
  const [requested, setRequested] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const change = useWorkspaceChange();
  const waiting = requested.length > 0;
  useEffect(() => {
    if (!key) return;
    let active = true;
    let timer: number | undefined;
    const again = () => {
      timer = window.setTimeout(() => setTick((v) => v + 1), POLL_MS);
    };
    syncReview.availability(key.split("\n")).then(
      (next) => {
        if (!active) return;
        setFound(next);
        setAnswered(key);
        if (waiting || next.some((item) => item.state === "downloading"))
          again();
      },
      // A failed read says nothing about the files: what was last known stays.
      // (A Workspace without sync answers with no entries, not a failure.)
      () => {
        if (!active) return;
        setAnswered(key);
        if (waiting) again();
      },
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, change, tick, waiting]);
  const download = useCallback(async (id: string) => {
    setRequested((ids) => [...ids, id]);
    try {
      // Answers when the file is here; progress is read meanwhile.
      await syncReview.download(id);
    } finally {
      setRequested((ids) => ids.filter((other) => other !== id));
      setTick((value) => value + 1);
    }
  }, []);
  return {
    of: (id) => {
      const item = found.find((item) => item.id === id);
      // The host marks the file as downloading a moment after it was asked to.
      return item?.state === "not_downloaded" && requested.includes(id)
        ? { ...item, state: "downloading" }
        : item;
    },
    download,
    known: !key || answered === key,
  };
}
