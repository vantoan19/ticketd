import { invoke } from "@/lib/api/bridge-failure";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const workspaceInfoSchema = lazySchema(() =>
  z.object({
    path: z.string(),
    tickets: z.number(),
    documents: z.number(),
    projects: z.number(),
    active_plans: z.number(),
    size_bytes: z.number(),
    format_version: z.number(),
  }),
);
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

const projectIconSchema = lazySchema(() =>
  z
    .object({
      mime: z.enum([
        "image/svg+xml",
        "image/png",
        "image/x-icon",
        "image/jpeg",
        "image/webp",
        "image/gif",
      ]),
      bytes: z.array(z.number().int().min(0).max(255)),
    })
    .nullable(),
);
export type ProjectFavicon = NonNullable<z.infer<typeof projectIconSchema>>;

const workspaceSummarySchema = lazySchema(() =>
  z.object({
    last_change: z.string().nullable(),
    tickets: z.number(),
    documents: z.number(),
    activities: z.number(),
    evidence: z.number(),
    projects: z.number(),
    plans: z.number(),
  }),
);
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

const backupInspectionSchema = lazySchema(() =>
  z.object({
    path: z.string(),
    current: workspaceSummarySchema,
    attachment_content: z
      .object({
        container_version: z.number().nullable(),
        local_snapshots: z.number(),
        retained_files: z.number(),
        retained_bytes: z.number(),
        remote_references: z.number(),
        remote_bytes_included: z.boolean().optional(),
        remote_access_verified: z.boolean().optional(),
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
  }),
);
export type BackupInspection = z.infer<typeof backupInspectionSchema>;

const restorePointSchema = lazySchema(() =>
  z.object({
    path: z.string(),
    kind: z.enum(["daily", "manual", "safety", "pre_migration"]),
    saved_at: z.string(),
    size_bytes: z.number(),
    summary: workspaceSummarySchema.nullable(),
    problem: z.string().nullable(),
    update_version: z.string().optional(),
  }),
);
export type RestorePoint = z.infer<typeof restorePointSchema>;

const restorePointListSchema = lazySchema(() =>
  z.object({
    points: z.array(restorePointSchema),
    total_bytes: z.number(),
  }),
);
export type RestorePointList = z.infer<typeof restorePointListSchema>;

export const workspaceClient = {
  async info() {
    return workspaceInfoSchema.parse(await invoke("workspace_info"));
  },
  /** Where the workspace file is, read without opening it. */
  async location() {
    return z.string().parse(await invoke("workspace_location"));
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
  /**
   * The daily restore points and the copies saved before a restore or an update, newest
   * first, and the disk they use.
   */
  async restorePoints() {
    return restorePointListSchema.parse(await invoke("restore_points"));
  },
  /** Back up now: one more restore point, saved at once with no file to choose. */
  async saveRestorePoint() {
    return restorePointSchema.parse(await invoke("save_restore_point"));
  },
  /** Shows the workspace file in the platform file manager. */
  async reveal(path: string) {
    await revealItemInDir(path);
  },
  /** The favicon a Project's folder ships, probed now; null when it has none. */
  async projectIcon(id: string) {
    return projectIconSchema.parse(await invoke("project_icon", { id }));
  },
  /** Opens an https link in the default browser. */
  async openLink(url: string) {
    if (!url.startsWith("https://")) throw new Error("Only https links open.");
    await openUrl(url);
  },
};
