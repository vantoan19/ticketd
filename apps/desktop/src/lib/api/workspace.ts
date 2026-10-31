import { invoke } from "@tauri-apps/api/core";
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

export const workspaceClient = {
  async info() {
    return workspaceInfoSchema.parse(await invoke("workspace_info"));
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
