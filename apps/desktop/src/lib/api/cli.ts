import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

/** A `ticketd` that comes first on PATH but is not this app's copy and does not match it. */
const otherCliSchema = lazySchema(() =>
  z.object({ path: z.string(), version: z.string().nullable() }),
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
        in_the_way: otherCliSchema.nullable(),
      })
      .optional(),
  }),
);

const installationSchema = lazySchema(() =>
  z.object({
    /** `declined`: the administrator password was declined and nothing changed;
     * `directory` is then the folder that needs no password. */
    outcome: z.enum(["installed", "declined"]),
    directory: z.string(),
    next_step: z.enum(["add_to_path", "restart_terminals"]).nullable(),
  }),
);

export type CliStatus = z.infer<typeof cliStatusSchema>;
export type OtherCli = z.infer<typeof otherCliSchema>;
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
  /**
   * The one fix: links this app's `ticketd` where terminals find it and removes
   * `other`, the copy in the way. On macOS and Linux the system asks for the
   * administrator password once for both. Setup runs this, then installs the
   * agent skills, so a person is asked once.
   */
  async install(other: OtherCli | null = null): Promise<CliInstallation> {
    return installationSchema.parse(await invoke("install_cli", { other }));
  },
  /** After a declined password: a link in `~/.local/bin`, which needs none. */
  async installInUserBin(): Promise<CliInstallation> {
    return installationSchema.parse(await invoke("install_cli_in_user_bin"));
  },
};
