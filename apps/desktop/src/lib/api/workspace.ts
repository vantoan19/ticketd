import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { z } from "zod";

const workspaceInfoSchema = z.object({
  path: z.string(),
  tickets: z.number(),
  projects: z.number(),
  active_efforts: z.number(),
  size_bytes: z.number(),
  format_version: z.number(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

const lastBackupSchema = z
  .object({ path: z.string(), completed_at: z.string() })
  .nullable();
export type BackupRecord = NonNullable<z.infer<typeof lastBackupSchema>>;

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
