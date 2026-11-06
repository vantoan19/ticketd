import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { z } from "zod";

const workspaceInfoSchema = z.object({
  path: z.string(),
  tickets: z.number(),
  documents: z.number(),
  projects: z.number(),
  active_plans: z.number(),
  size_bytes: z.number(),
  format_version: z.number(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

const lastBackupSchema = z
  .object({ path: z.string(), completed_at: z.string() })
  .nullable();
export type BackupRecord = NonNullable<z.infer<typeof lastBackupSchema>>;

const workspaceSummarySchema = z.object({
  last_change: z.string().nullable(),
  tickets: z.number(),
  documents: z.number(),
  activities: z.number(),
  evidence: z.number(),
  projects: z.number(),
  plans: z.number(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

const backupInspectionSchema = z.object({
  path: z.string(),
  current: workspaceSummarySchema,
  attachment_content: z
    .object({
      container_version: z.number().nullable(),
      local_snapshots: z.number(),
      retained_files: z.number(),
      retained_bytes: z.number(),
      remote_references: z.number(),
    })
    .optional(),
  check: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("valid"),
      format_version: z.number(),
      summary: workspaceSummarySchema,
    }),
    z.object({
      status: z.literal("newer_format"),
      backup_version: z.number(),
      supported_version: z.number(),
    }),
    z.object({ status: z.literal("not_ticketd") }),
    z.object({
      status: z.literal("missing_tables"),
      tables: z.array(z.string()),
    }),
    z.object({ status: z.literal("current_workspace") }),
    z.object({ status: z.literal("damaged"), reason: z.string() }),
  ]),
});
export type BackupInspection = z.infer<typeof backupInspectionSchema>;

const safetyBackupsSchema = z.array(
  z.object({
    path: z.string(),
    kind: z.enum(["safety", "pre_migration"]),
    saved_at: z.string(),
    size_bytes: z.number(),
  }),
);
export type SafetyBackup = z.infer<typeof safetyBackupsSchema>[number];

export const workspaceClient = {
  async info() {
    return workspaceInfoSchema.parse(await invoke("workspace_info"));
  },
  /** The most recent successful backup, including ones made with the CLI. */
  async lastBackup() {
    return lastBackupSchema.parse(await invoke("last_backup"));
  },
  /** Opens a native save dialog; resolves to null when it is cancelled. */
  async chooseSavePath(options: {
    title: string;
    defaultPath: string;
    filterName: string;
    extension: string;
  }) {
    return save({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: [{ name: options.filterName, extensions: [options.extension] }],
    });
  },
  /** Opens a native open dialog for one backup file; resolves to null when it is cancelled. */
  async chooseBackupFile(options: { title: string }) {
    const chosen = await open({
      title: options.title,
      multiple: false,
      directory: false,
      filters: [
        { name: "ticketd backup", extensions: ["sqlite3", "sqlite", "db"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return typeof chosen === "string" ? chosen : null;
  },
  /** Opens a native folder picker; resolves to null when it is cancelled. */
  async chooseFolder(options: { title: string }) {
    const chosen = await open({
      title: options.title,
      multiple: false,
      directory: true,
    });
    return typeof chosen === "string" ? chosen : null;
  },
  /** Checks a backup and summarizes it beside this workspace; changes nothing. */
  async inspectBackup(path: string) {
    return backupInspectionSchema.parse(
      await invoke("inspect_backup", { path }),
    );
  },
  /** Safety and pre-migration backups kept beside the workspace, newest first. */
  async safetyBackups() {
    return safetyBackupsSchema.parse(await invoke("safety_backups"));
  },
  /** Shows the workspace file in the platform file manager. */
  async reveal(path: string) {
    await revealItemInDir(path);
  },
  /** Opens an https link in the default browser. */
  async openLink(url: string) {
    if (!url.startsWith("https://")) throw new Error("Only https links open.");
    await openUrl(url);
  },
};
