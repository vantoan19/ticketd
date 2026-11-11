import type { SyncStatus } from "@/lib/sync-api";
import { changes } from "./sync-status";

export type RecoveryCopy = {
  /** The sidebar footer line. */
  label: string;
  title: string;
  /** Says that local work is safe. */
  description: string;
  /** The one corrective action. */
  action: string;
};

/** Wording for what stopped sync; `null` while nothing did. */
export function recoveryCopy(status: SyncStatus): RecoveryCopy | null {
  const waiting = status.pending_uploads.length;
  const are = waiting === 1 ? "is" : "are";
  switch (status.recovery) {
    case null:
      return null;
    case "folder_missing":
      return {
        label: "Drive folder missing",
        title: "Sync folder not found in Drive",
        description: `${status.folder ? `“${status.folder.name}”` : "The folder"} was deleted or moved. Nothing was removed from this computer.`,
        action: "Upload again",
      };
    case "authorization_expired":
      return {
        label: "Drive sign-in expired",
        title: "Sign in to Google Drive again",
        description: `Your work is saved on this computer.${waiting ? ` ${changes(waiting)} upload${waiting === 1 ? "s" : ""} once you reconnect.` : ""}`,
        action: "Reconnect",
      };
    case "storage_full":
      return {
        label: "Google Drive is full",
        title: "Google Drive is full",
        description: waiting
          ? `${changes(waiting)} ${are} saved on this computer and upload once there is space.`
          : "Your work is saved on this computer. Changes upload once there is space.",
        action: "Retry",
      };
    case "offline":
      return {
        label: "Saved on this computer",
        title: "Offline",
        description:
          "Changes are saved on this computer and upload when you are back online.",
        action: "Retry",
      };
    case "rate_limited":
      return {
        label: "Saved on this computer",
        title: "Google Drive is busy",
        description:
          "Google Drive asked ticketd to slow down. Changes are saved on this computer and upload a little later.",
        action: "Retry",
      };
  }
}
