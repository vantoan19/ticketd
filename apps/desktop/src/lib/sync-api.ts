import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { invoke as bridge, structured } from "@/lib/api/bridge-failure";

/**
 * The desktop's contract with the core for Workspace sync through Google Drive.
 * The core decides every state; the screens only pick wording. Each command that
 * changes something answers with the new `SyncStatus`, so no screen has to wait
 * for the next poll.
 */

/** One record or file that has not reached Drive yet. */
const pendingItemSchema = z.object({
  kind: z.enum([
    "ticket",
    "document",
    "plan",
    "project",
    "automation_agent",
    "automation",
    "attachment",
  ]),
  /** The record's or Attachment's GUID. */
  id: z.string(),
  /** The Ticket reference, for a ticket. */
  reference: z.string().nullable(),
  /** The record's title, or the Attachment's file name. */
  title: z.string(),
});
export type SyncPendingItem = z.infer<typeof pendingItemSchema>;

/** A record changed on two desktops in the same field, waiting for the person's choice. */
const reviewItemSchema = z.object({
  kind: z.enum([
    "ticket",
    "document",
    "plan",
    "project",
    "automation_agent",
    "automation",
  ]),
  id: z.string(),
  reference: z.string().nullable(),
  title: z.string(),
});
export type SyncReviewItem = z.infer<typeof reviewItemSchema>;

export const syncStates = [
  "saved_locally",
  "upload_pending",
  "uploaded",
  "attachment_download_pending",
  "needs_attention",
] as const;
export type SyncState = (typeof syncStates)[number];

/** What stopped sync. Local work is safe in every case; each has one corrective action. */
export const syncRecoveries = [
  "folder_missing",
  "authorization_expired",
  "storage_full",
  "offline",
  /** Google Drive asked for fewer requests; sync tries again by itself. */
  "rate_limited",
  /**
   * The S3 profile now reaches another service than the Workspace's bucket was connected
   * through; `recovery_message` says which. Disconnect (then connect again) moves the bucket
   * on purpose; pointing the profile back, then Retry, undoes the edit.
   */
  "service_changed",
  /**
   * The `aws` program is missing or too old; `recovery_message` says which. Choosing where
   * it is (or installing it), then Retry, gets sync going again.
   */
  "cli_unavailable",
  /** Any other failed run; `recovery_message` says what went wrong. */
  "error",
] as const;
export type SyncRecovery = (typeof syncRecoveries)[number];

const statusSchema = z.object({
  /**
   * `not_connected`: no Drive account. `choosing`: signed in, and the person has
   * not yet said whether to upload this Workspace or download an existing one.
   * `connected`: this Workspace syncs with `folder`.
   */
  connection: z.enum(["not_connected", "choosing", "connected"]),
  /** The signed-in Google account's email address (an AWS identity for S3). */
  account: z.string().nullable(),
  /** Where the sign-in is kept; Files uses the same one while this is set. */
  connection_id: z.string().nullish(),
  /** The storage this Workspace syncs with. Wording that names it follows this. */
  provider: z.enum(["google_drive", "s3"]),
  /** For S3: the bucket and prefix of the Workspace folders and this desktop's AWS CLI profile. */
  s3: z
    .object({
      bucket: z.string(),
      prefix: z.string(),
      profile: z.string(),
      aws_cli_path: z.string().nullable(),
    })
    .nullable(),
  /** The Workspace's Drive folder, once connected. */
  folder: z.object({ id: z.string().optional(), name: z.string() }).nullable(),
  state: z.enum(syncStates),
  /** RFC 3339 time of the last completed sync with Drive. */
  last_synced_at: z.string().nullable(),
  /**
   * Changes saved locally that have not been uploaded. A long list is cut to
   * its first entries; `pending_total` then says how many there are.
   */
  pending_uploads: z.array(pendingItemSchema),
  pending_total: z.number().int().nonnegative().optional(),
  /** Managed Attachments still downloading to this desktop. */
  attachment_downloads: z.object({
    count: z.number().int().nonnegative(),
    bytes_left: z.number().nonnegative(),
  }),
  needs_review: z.array(reviewItemSchema),
  recovery: z.enum(syncRecoveries).nullable(),
  /** What went wrong, while `recovery` is `error`, `service_changed` or `cli_unavailable`. */
  recovery_message: z.string().nullable().optional(),
  /** Progress of the first upload or download after setup; `null` once it finished. */
  first_sync: z
    .object({
      direction: z.enum(["upload", "download"]),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type SyncStatus = z.infer<typeof statusSchema>;
/** The storage a Workspace syncs with. */
export type SyncProvider = SyncStatus["provider"];

const countsSchema = z.object({
  tickets: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
});
export type SyncCounts = z.infer<typeof countsSchema>;

const setupOptionsSchema = z.object({
  /** What this desktop's Workspace holds: uploaded, or replaced by a download. */
  local: countsSchema,
  /** Workspaces ticketd already keeps in this Drive account. */
  existing: z.array(
    z.object({
      folder_id: z.string(),
      folder_name: z.string(),
      /** The desktop that synced it last, by its name. */
      last_synced_by: z.string().nullable(),
      last_synced_at: z.string().nullable(),
      counts: countsSchema,
    }),
  ),
  /** The folder this Workspace synced with before it was disconnected, while it can go back to it. */
  reconnect: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type SyncSetupOptions = z.infer<typeof setupOptionsSchema>;

export const SYNC_MIN_POLL_SECS = 30;

const settingsSchema = z.object({
  /** How other desktops name this one; defaults to the computer's name. */
  desktop_name: z.string(),
  /** This desktop's two-letter Ticket reference code. Read only. */
  device_code: z.string(),
  /** Seconds between checks for changes in Drive; at least `SYNC_MIN_POLL_SECS`. */
  poll_interval_secs: z.number().int().min(SYNC_MIN_POLL_SECS),
  attachment_download: z.enum(["automatic", "on_open"]),
});
export type SyncSettings = z.infer<typeof settingsSchema>;
export type SyncSettingsChange = Omit<SyncSettings, "device_code">;

/** One computer of the device list: this one, or another that joined the same Workspace. */
const deviceSchema = z.object({
  id: z.string(),
  /** How the computer is named; this one's name is the one in force now. */
  name: z.string(),
  /** The two-letter code in the references of tickets made there. */
  code: z.string(),
  /** RFC 3339 time of its last uploaded change; `null` before it has uploaded one. */
  last_synced_at: z.string().nullable(),
  /** The computer the list is read on. */
  this: z.boolean(),
});
export type SyncDevice = z.infer<typeof deviceSchema>;

const exitReportSchema = z.object({
  /** What still had not uploaded when the flush ended; empty when everything did. */
  pending: z.array(pendingItemSchema),
  /** How many are left when `pending` holds only the first of them. */
  pending_total: z.number().int().nonnegative().optional(),
});
export type SyncExitReport = z.infer<typeof exitReportSchema>;

/** Every sync command rejects with the host's structured failure; callers get its message. */
const invoke = (...call: Parameters<typeof bridge>) =>
  structured(bridge<unknown>(...call));

const status = async (call: Promise<unknown>) => statusSchema.parse(await call);

export const syncApi = {
  /** `sync_status`: read only and cheap; read once, then followed by `onSyncStatus`. */
  status: () => status(invoke("sync_status")),

  /**
   * `sync_connect`: Google sign-in in the browser; resolves once it finished.
   * Leaves a connected Workspace connected, so it also serves to sign in again.
   */
  connect: () => status(invoke("sync_connect")),

  /**
   * `use_another_google_account`: Google sign-in in the browser with another account,
   * for Files and Workspace sync together. Nothing changes until the sign-in has finished.
   */
  useAnotherAccount: () => status(invoke("use_another_google_account")),

  /**
   * `sync_connect_s3`: records S3 as this Workspace's storage, signed in through
   * the AWS CLI `profile`. The prefix is written as the person likes; the host
   * keeps it with one trailing slash. Choosing a Workspace follows.
   */
  connectS3: (change: { bucket: string; prefix: string; profile: string }) =>
    status(invoke("sync_connect_s3", change)),

  /** `sync_setup_options`: what the setup choices would do, while `choosing`. */
  async setupOptions(): Promise<SyncSetupOptions> {
    return setupOptionsSchema.parse(await invoke("sync_setup_options"));
  },

  /**
   * `sync_reconnect`: back to the folder of `setupOptions().reconnect`. The sync
   * that follows merges both sides; nothing is replaced.
   */
  reconnect: () => status(invoke("sync_reconnect")),

  /** `sync_upload_workspace`: creates the Drive folder and starts the first upload. */
  uploadWorkspace: () => status(invoke("sync_upload_workspace")),

  /**
   * `sync_download_workspace`: saves a safety backup, replaces this desktop's
   * Workspace with the one in `folderId` and starts the first download. Answers
   * with the new status and the path of the safety backup.
   */
  async downloadWorkspace(
    folderId: string,
  ): Promise<SyncStatus & { safety_backup: string }> {
    return statusSchema
      .extend({ safety_backup: z.string() })
      .parse(await invoke("sync_download_workspace", { folderId }));
  },

  /** `sync_now`: uploads and checks for changes now. */
  syncNow: () => status(invoke("sync_now")),

  /**
   * `sync_recover`: the one corrective action for the current `recovery`: upload
   * again (folder missing), sign in again (authorization expired) or retry.
   */
  recover: () => status(invoke("sync_recover")),

  /** `sync_disconnect`: stops sync on this desktop. Deletes nothing, here or in Drive. */
  disconnect: () => status(invoke("sync_disconnect")),

  /** `sync_open_folder`: shows the Workspace's folder in Google Drive, in the browser. */
  async openFolder(): Promise<void> {
    await invoke("sync_open_folder");
  },

  /** `sync_settings` */
  async settings(): Promise<SyncSettings> {
    return settingsSchema.parse(await invoke("sync_settings"));
  },

  /**
   * `sync_devices`: the computers that share this Workspace, this one first. Read
   * from this computer's copy of the device registry: no sign-in, no network.
   */
  async devices(): Promise<SyncDevice[]> {
    return z.array(deviceSchema).parse(await invoke("sync_devices"));
  },

  /** `set_sync_settings`: rejects a poll interval under `SYNC_MIN_POLL_SECS`. */
  async setSettings(settings: SyncSettingsChange): Promise<SyncSettings> {
    return settingsSchema.parse(
      await invoke("set_sync_settings", { settings }),
    );
  },

  /**
   * `sync_flush_on_exit`: uploads what is pending and resolves when it is done
   * or after 10 seconds, whichever comes first. Never rejects for a failed upload.
   */
  async flushOnExit(): Promise<SyncExitReport> {
    return exitReportSchema.parse(await invoke("sync_flush_on_exit"));
  },
};

/**
 * Calls `handler` with the sync status each time the desktop sees it change
 * (`sync-status`), so nothing polls it. Resolves to a function that stops
 * listening. Outside the desktop shell nothing is sent.
 */
export async function onSyncStatus(
  handler: (status: SyncStatus) => void,
): Promise<() => void> {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  return listen<unknown>("sync-status", (event) => {
    const status = statusSchema.safeParse(event.payload);
    if (status.success) handler(status.data);
  });
}
