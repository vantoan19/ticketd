import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const olderCliSchema = lazySchema(() =>
  z.object({ path: z.string(), version: z.string() }),
);

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
    bundled: z
      .object({
        platform: z.enum(["macos", "linux", "windows"]),
        installed: z.boolean(),
        needs_repair: z.boolean().optional(),
        older: olderCliSchema.nullable(),
      })
      .optional(),
  }),
);

const installationSchema = lazySchema(() =>
  z.object({
    directory: z.string(),
    next_step: z.enum(["add_to_path", "restart_terminals"]).nullable(),
  }),
);

export type CliStatus = z.infer<typeof cliStatusSchema>;
export type OlderCli = z.infer<typeof olderCliSchema>;
export type CliInstallation = z.infer<typeof installationSchema>;

export const cliClient = {
  /** Looks for `ticketd` on the user's PATH and checks it against this app. */
  async check(refreshPath = false): Promise<CliStatus> {
    return cliStatusSchema.parse(
      await (refreshPath
        ? invoke("check_cli", { refreshPath })
        : invoke("check_cli")),
    );
  },
  async install(): Promise<CliInstallation> {
    return installationSchema.parse(await invoke("install_cli"));
  },
  async removeOlder(older: OlderCli): Promise<void> {
    await invoke("remove_older_cli", { older });
  },
};
