import type { SyncStatus } from "@/lib/sync-api";
import { storageName } from "./storage-name";
import { changes, pendingCount } from "./sync-status";

export type RecoveryCopy = {
  /** The sidebar footer line. */
  label: string;
  title: string;
  /** Says that local work is safe. */
  description: string;
  /** The one corrective action. */
  action: string;
  /** What the action says while it runs, when that waits on the person. */
  working: string | null;
};

/** Wording for what stopped sync; `null` while nothing did. */
export function recoveryCopy(status: SyncStatus): RecoveryCopy | null {
  const waiting = pendingCount(status);
  const are = waiting === 1 ? "is" : "are";
  const storage = storageName(status.provider);
  const s3 = status.provider === "s3";
  switch (status.recovery) {
    case null:
      return null;
    case "folder_missing":
      return {
        label: `${storage.short} folder missing`,
        title: `Sync folder not found in ${storage.short}`,
        description: `${status.folder ? `“${status.folder.name}”` : "The folder"} was deleted or moved. Nothing was removed from this computer.`,
        action: "Upload again",
        working: null,
      };
    case "authorization_expired":
      return {
        label: s3 ? "AWS sign-in expired" : "Drive sign-in expired",
        title: s3 ? "Sign in to AWS again" : "Sign in to Google Drive again",
        description: `Your work is saved on this computer.${waiting ? ` ${changes(waiting)} upload${waiting === 1 ? "s" : ""} once you ${s3 ? "sign in" : "reconnect"}.` : ""}`,
        // The AWS CLI's own sign-in opens in the browser and is waited for.
        action: s3 ? "Sign in" : "Reconnect",
        working: s3 ? "Waiting for sign-in…" : null,
      };
    case "storage_full":
      return {
        label: `${storage.full} is full`,
        title: `${storage.full} is full`,
        description: waiting
          ? `${changes(waiting)} ${are} saved on this computer and upload once there is space.`
          : "Your work is saved on this computer. Changes upload once there is space.",
        action: "Retry",
        working: null,
      };
    case "offline":
      return {
        label: "Saved on this computer",
        title: "Offline",
        description:
          "Changes are saved on this computer and upload when you are back online.",
        action: "Retry",
        working: null,
      };
    case "rate_limited":
      return {
        label: "Saved on this computer",
        title: `${storage.full} is busy`,
        description: `${storage.full} asked ticketd to slow down. Changes are saved on this computer and upload a little later.`,
        action: "Retry",
        working: null,
      };
    case "service_changed":
      return {
        label: `${storage.short} sync stopped`,
        title: "Sync stopped",
        // The core's sentence names both services and both ways out.
        description: `${status.recovery_message ?? "This profile now reaches another service than this Workspace's bucket was connected through."} Your work is saved on this computer.`,
        action: "Disconnect",
        working: null,
      };
    case "error":
      return {
        label: "Sync needs attention",
        title: "Sync could not finish",
        description: `Your work is saved on this computer.${status.recovery_message ? ` The last sync stopped with: ${status.recovery_message}` : ""}`,
        action: "Retry",
        working: null,
      };
  }
}
