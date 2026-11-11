import { useCallback, useEffect, useState } from "react";
import { syncReview, type Availability } from "@/lib/sync-review-api";
import { useWorkspaceChange } from "@/lib/workspace-change";

const POLL_MS = 2000;

/** The Storage wording of a managed Attachment; without sync every file is local. */
export function storageWord(availability: Availability | undefined): string {
  if (availability?.state === "downloading") return "Downloading…";
  if (availability?.state === "not_downloaded") return "Not downloaded";
  return "Local snapshot";
}

/**
 * Whether the bytes of the named managed Attachments are on this desktop,
 * keyed by id, and the action that fetches one. It follows Workspace changes
 * and, while a file is downloading, asks again every two seconds.
 */
export function useAvailability(ids: string[]): {
  of: (id: string) => Availability | undefined;
  download: (id: string) => Promise<void>;
} {
  const key = ids.join("\n");
  const [found, setFound] = useState<Availability[]>([]);
  const [tick, setTick] = useState(0);
  const change = useWorkspaceChange();
  useEffect(() => {
    if (!key) return;
    let active = true;
    let timer: number | undefined;
    syncReview.availability(key.split("\n")).then(
      (next) => {
        if (!active) return;
        setFound(next);
        if (next.some((item) => item.state === "downloading"))
          timer = window.setTimeout(() => setTick((v) => v + 1), POLL_MS);
      },
      // A Workspace without sync has every file on this desktop.
      () => {
        if (active) setFound([]);
      },
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, change, tick]);
  const download = useCallback(async (id: string) => {
    await syncReview.download(id);
    setTick((value) => value + 1);
  }, []);
  return { of: (id) => found.find((item) => item.id === id), download };
}
