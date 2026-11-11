import type { SyncSettings, SyncStatus } from "@/lib/sync-api";

/** A connected, fully synced Workspace; tests override what they exercise. */
export function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    connection: "connected",
    account: "you@example.com",
    folder: { name: "ticketd · web-app" },
    state: "uploaded",
    // Ninety seconds reads as "1 min ago" whichever second the minute clock last ticked.
    last_synced_at: new Date(Date.now() - 90_000).toISOString(),
    pending_uploads: [],
    attachment_downloads: { count: 0, bytes_left: 0 },
    needs_review: [],
    recovery: null,
    first_sync: null,
    ...overrides,
  };
}

export const notConnected = (): SyncStatus =>
  syncStatus({
    connection: "not_connected",
    account: null,
    folder: null,
    state: "saved_locally",
    last_synced_at: null,
  });

export const syncSettings = (
  overrides: Partial<SyncSettings> = {},
): SyncSettings => ({
  desktop_name: "Laptop",
  device_code: "KQ",
  poll_interval_secs: 60,
  attachment_download: "automatic",
  ...overrides,
});
