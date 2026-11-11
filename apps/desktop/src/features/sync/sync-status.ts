import { createContext, useContext, useEffect } from "react";
import type { SyncStatus } from "@/lib/sync-api";

export type SyncStatusValue = {
  /** The latest sync status; `null` until the first read, or when it cannot be read. */
  status: SyncStatus | null;
  /** Shows the status a sync command just answered with, ahead of the next poll. */
  apply: (status: SyncStatus) => void;
  /** Reads the status now. Rejects when it cannot be read. */
  refresh: () => Promise<SyncStatus>;
  /** Opens Settings › Sync. */
  openSettings: () => void;
  /** Opens the records that need review. */
  openReview: () => void;
  /** How the app shell opens those two places; see `useSyncNavigation`. */
  setNavigation: (navigation: SyncNavigation) => void;
};

export type SyncNavigation = {
  openSettings: () => void;
  openReview: () => void;
};

/** Without a provider (a view rendered alone) nothing syncs and nothing is shown. */
export const SyncStatusContext = createContext<SyncStatusValue>({
  status: null,
  apply: () => {},
  refresh: () => Promise.reject(new Error("sync status is not available")),
  openSettings: () => {},
  openReview: () => {},
  setNavigation: () => {},
});

/** Sync status for every place that shows it; `SyncStatusProvider` owns the one poll. */
export function useSyncStatus(): SyncStatusValue {
  return useContext(SyncStatusContext);
}

/** The app shell says where Settings › Sync and the records to review open. */
export function useSyncNavigation(navigation: SyncNavigation) {
  const { setNavigation } = useSyncStatus();
  useEffect(() => setNavigation(navigation));
}

/** How many changes wait to upload; the list may hold only the first of them. */
export function pendingCount(
  status: Pick<SyncStatus, "pending_uploads" | "pending_total">,
): number {
  return status.pending_total ?? status.pending_uploads.length;
}

/** "3 changes", "1 change". */
export function changes(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}
