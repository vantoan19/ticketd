import type { SyncStatus } from "@/lib/sync-api";
import { storageName } from "./storage-name";
import { changes, pendingCount } from "./sync-status";
import { agoWords } from "./sync-words";

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

/** The state of a connected Workspace in a word, with the tone of its dot. */
export function connectionState(status: SyncStatus): {
  tone: "positive" | "neutral" | "attention";
  label: string;
} {
  switch (status.recovery) {
    case null:
      return { tone: "positive", label: "Connected" };
    case "offline":
      return { tone: "neutral", label: "Offline" };
    case "rate_limited":
      return { tone: "neutral", label: "Slowed down" };
    case "authorization_expired":
      return { tone: "attention", label: "Signed out" };
    case "folder_missing":
      return { tone: "attention", label: "Folder missing" };
    case "storage_full":
      return { tone: "attention", label: "Storage full" };
    case "service_changed":
    case "cli_unavailable":
    case "error":
      return { tone: "attention", label: "Not syncing" };
  }
}

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
        description: `Your work is saved on this computer.${waiting ? ` ${changes(waiting)} upload${waiting === 1 ? "s" : ""} once you sign in.` : ""}`,
        // Both sign-ins open in the browser and are waited for.
        action: "Sign in",
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
    case "cli_unavailable":
      return {
        label: "AWS CLI needed",
        title: "Sync can't use the AWS CLI",
        description: `${status.recovery_message ?? "The AWS CLI is missing or too old."} Your work is saved on this computer.`,
        action: "Choose the aws program…",
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

/** What the status row at the top of Settings › Workspace sync says. */
export type StatusRow = {
  tone: "positive" | "neutral" | "attention";
  /** The state in a word or two, beside its dot. */
  label: string;
  /** What it means: the sign-in, or the cause and what is kept meanwhile. */
  description: string;
};

/** The sign-in a connected Workspace uses, named where the page says it works. */
function signedInAs(status: SyncStatus): string | null {
  const profile = status.s3 ? `profile “${status.s3.profile}”` : null;
  const account = status.account ? `signed in as ${status.account}` : null;
  return [profile, account].filter(Boolean).join(" · ") || null;
}

/**
 * The status row of a connected Workspace: one dot and word, then one sentence. A
 * problem is the row's own state (never a green dot beside a warning) and says what
 * is kept meanwhile; the fix is `recoveryCopy(status).action`, the status line's too.
 */
export function statusRow(status: SyncStatus, now: number): StatusRow {
  const waiting = pendingCount(status);
  const are = waiting === 1 ? "is" : "are";
  const storage = storageName(status.provider);
  const kept = (when: string) =>
    waiting
      ? `${changes(waiting)} ${are} saved here and upload ${when}.`
      : "Your work is saved on this computer.";
  const state = connectionState(status);
  const copy = recoveryCopy(status);
  const row = (description: string): StatusRow => ({ ...state, description });
  switch (status.recovery) {
    case "authorization_expired":
      return row(
        `${
          status.s3
            ? `The AWS CLI sign-in for profile “${status.s3.profile}” ended.`
            : "Your Google sign-in ended."
        } ${kept("after you sign in")}`,
      );
    case "storage_full":
      return row(`${storage.full} is full. ${kept("once there is space")}`);
    case "offline":
      return row(
        `ticketd can't reach ${storage.full}. ${kept("when you are back online")}`,
      );
    case "rate_limited":
      return row(
        `${storage.full} asked ticketd to slow down. ${kept("a little later")}`,
      );
    case "folder_missing":
    case "service_changed":
    case "cli_unavailable":
    case "error":
      // Their sentences say it all, and say the work is safe.
      return row(copy?.description ?? "");
    case null:
      break;
  }
  const checked = status.last_synced_at
    ? `Checked ${agoWords(status.last_synced_at, now) ?? status.last_synced_at}`
    : "Not checked yet";
  const description = [checked, signedInAs(status)].filter(Boolean).join(" · ");
  const files = status.attachment_downloads.count;
  switch (status.state) {
    case "uploaded":
      return { tone: "positive", label: "Synced", description };
    case "upload_pending":
      return {
        tone: "neutral",
        label: waiting ? `Uploading ${changes(waiting)}…` : "Uploading…",
        description,
      };
    case "saved_locally":
      return { tone: "neutral", label: "Saved on this computer", description };
    case "attachment_download_pending":
      return {
        tone: "neutral",
        label: `Downloading ${files} ${files === 1 ? "file" : "files"}…`,
        description,
      };
    case "needs_attention": {
      const records = status.needs_review.length;
      return {
        tone: "attention",
        label: "Needs review",
        description: `${records} ${records === 1 ? "record" : "records"} changed on two computers.`,
      };
    }
  }
}
