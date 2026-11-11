import { useEffect, useState } from "react";
import { pendingCount, useSyncStatus } from "./sync-status";

export type RecordSyncState = "synced" | "needs_review";

/**
 * Whether one saved record has reached Drive, for its own status line; `null`
 * while it has not, or when this Workspace does not sync. `saved` is false while
 * the record has an unsaved or in-flight edit. After each save the status is read
 * again before the record may say it is synced, so the line never claims an
 * upload the last poll could not have known about.
 */
export function useRecordSyncState(
  id: string | null,
  saved: boolean,
): RecordSyncState | null {
  const { status, refresh } = useSyncStatus();
  const [wasSaved, setWasSaved] = useState(saved);
  const [current, setCurrent] = useState(true);
  if (wasSaved !== saved) {
    setWasSaved(saved);
    setCurrent(false);
  }
  useEffect(() => {
    if (!saved || current) return;
    let active = true;
    refresh().then(
      () => {
        if (active) setCurrent(true);
      },
      () => {
        // Unknown is not synced.
      },
    );
    return () => {
      active = false;
    };
  }, [saved, current, refresh]);
  if (!id || !saved || !current || status?.connection !== "connected")
    return null;
  if (status.needs_review.some((item) => item.id === id)) return "needs_review";
  return status.state === "saved_locally" ||
    status.recovery ||
    status.first_sync ||
    status.pending_uploads.some((item) => item.id === id) ||
    // The record may be among the changes the list leaves out.
    pendingCount(status) > status.pending_uploads.length
    ? null
    : "synced";
}
