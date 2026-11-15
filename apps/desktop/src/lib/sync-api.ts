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
  kind: z.enum(["ticket", "document", "plan", "project", "attachment"]),
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
  kind: z.enum(["ticket", "document", "plan", "project"]),
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
  /** The signed-in Google account's email address. */
  account: z.string().nullable(),
  /** The Workspace's Drive folder, once connected. */
  folder: z.object({ name: z.string() }).nullable(),
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
  /** What went wrong, while `recovery` is `error`. */
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
  /** `sync_status`: read only and cheap; the app polls it every two seconds. */
  status: () => status(invoke("sync_status")),

  /**
   * `sync_connect`: Google sign-in in the browser; resolves once it finished.
   * Leaves a connected Workspace connected, so it also serves to sign in again.
   */
  connect: () => status(invoke("sync_connect")),

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
