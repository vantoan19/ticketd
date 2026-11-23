import type { SyncProvider } from "@/lib/sync-api";

/** How a sync storage is named where the interface speaks of it. */
export type StorageName = {
  /** In full: "Google Drive", "S3". */
  full: string;
  /** For a line that has little room: "Drive", "S3". */
  short: string;
};

const NAMES: Record<SyncProvider, StorageName> = {
  google_drive: { full: "Google Drive", short: "Drive" },
  s3: { full: "S3", short: "S3" },
};

/**
 * The storage a Workspace syncs with. Without a status, Google Drive: it is
 * what a Workspace syncs with until another storage is connected.
 */
export function storageName(
  provider: SyncProvider | null | undefined,
): StorageName {
  return NAMES[provider ?? "google_drive"];
}
