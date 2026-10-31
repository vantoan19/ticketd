import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const cliStatusSchema = z.object({
  found: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  version_matches: z.boolean().nullable(),
  workspace_path: z.string().nullable(),
  workspace_matches: z.boolean().nullable(),
  app_version: z.string(),
  app_workspace_path: z.string().nullable(),
  suggested_directory: z.string(),
});

export type CliStatus = z.infer<typeof cliStatusSchema>;

export const cliClient = {
  /** Looks for `ticketd` on the user's PATH and checks it against this app. */
  async check(): Promise<CliStatus> {
    return cliStatusSchema.parse(await invoke("check_cli"));
  },
};
