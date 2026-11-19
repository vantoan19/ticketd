import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const logLevelSchema = lazySchema(() =>
  z.object({
    /** `info`, `debug`, or the TICKETD_LOG filter itself. */
    level: z.string(),
    /** Debug logging is on. */
    debug: z.boolean(),
    /** The TICKETD_LOG filter that overrides the switch, if one was set at launch. */
    env_override: z.string().nullable(),
  }),
);
export type LogLevel = z.infer<typeof logLevelSchema>;

const errorGroupsSchema = lazySchema(() =>
  z.array(
    z.object({
      target: z.string(),
      kind: z.string(),
      level: z.enum(["ERROR", "WARN"]),
      count: z.number(),
      first_seen: z.string(),
      last_seen: z.string(),
    }),
  ),
);
export type ErrorGroup = z.infer<typeof errorGroupsSchema>[number];

const exportedSchema = lazySchema(() =>
  z.object({ path: z.string(), bytes: z.number() }),
);
export type DiagnosticsExport = z.infer<typeof exportedSchema>;

/** Settings → Diagnostics: the local logs, and the redacted bundle made from them. */
export const diagnosticsClient = {
  async logLevel() {
    return logLevelSchema.parse(await invoke("diagnostics_log_level"));
  },
  /** Turns Debug logging on or off until ticketd restarts; resolves to the new level. */
  async setDebug(enabled: boolean) {
    return logLevelSchema.parse(
      await invoke("diagnostics_set_debug", { enabled }),
    );
  },
  /** Shows the logs folder in the file manager. */
  async openLogsFolder() {
    await invoke("diagnostics_open_logs_folder");
  },
  /** Warnings and errors grouped by kind, most recently seen first. */
  async recentErrors() {
    return errorGroupsSchema.parse(await invoke("diagnostics_recent_errors"));
  },
  /** The file name a new export suggests in the save dialog. */
  async exportFileName() {
    return z.string().parse(await invoke("diagnostics_export_file_name"));
  },
  /** The environment summary for pasting into an issue. */
  async summary() {
    return z.string().parse(await invoke("diagnostics_summary"));
  },
  /** Writes the bundle to `destination` and shows it in the file manager. */
  async export(destination: string) {
    return exportedSchema.parse(
      await invoke("diagnostics_export", { destination }),
    );
  },
};
