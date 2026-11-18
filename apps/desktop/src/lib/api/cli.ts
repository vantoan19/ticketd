import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const cliStatusSchema = lazySchema(() =>
  z.object({
    found: z.boolean(),
    on_path: z.boolean(),
    path: z.string().nullable(),
    version: z.string().nullable(),
    version_matches: z.boolean().nullable(),
    workspace_path: z.string().nullable(),
    workspace_matches: z.boolean().nullable(),
    app_version: z.string(),
    app_workspace_path: z.string().nullable(),
    suggested_directory: z.string(),
  }),
);

export type CliStatus = z.infer<typeof cliStatusSchema>;

export const cliClient = {
  /** Looks for `ticketd` on the user's PATH and checks it against this app. */
  async check(): Promise<CliStatus> {
    return cliStatusSchema.parse(await invoke("check_cli"));
  },
};
