import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const logLevelSchema = lazySchema(() =>
  z.object({
    /** `info`, `debug`, or the TICKETD_LOG filter itself. */
    level: z.string(),
    /** Detailed logging is on. */
    debug: z.boolean(),
    /** The TICKETD_LOG filter that overrides detailed logging, if one was set at launch. */
    env_override: z.string().nullable(),
    /**
     * When the open report started, while one is open. Detailed logging stays on, across a
     * restart, until the report is saved or cancelled.
     */
    report_started_at: z.string().nullable(),
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

const issueDetailsSchema = lazySchema(() =>
  z.object({ version: z.string(), environment: z.string() }),
);
/** What GitHub's bug form takes for its own `version` and `environment` fields. */
export type IssueDetails = z.infer<typeof issueDetailsSchema>;

/** Settings → Diagnostics: the local logs, and the redacted report made from them. */
export const diagnosticsClient = {
  async logLevel() {
    return logLevelSchema.parse(await invoke("diagnostics_log_level"));
  },
  /** Opens a report: detailed logging stays on, across a restart, until it is saved or cancelled. */
  async startReport() {
    return logLevelSchema.parse(await invoke("diagnostics_start_report"));
  },
  /** Cancels the open report and turns detailed logging off. */
  async cancelReport() {
    return logLevelSchema.parse(await invoke("diagnostics_cancel_report"));
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
  /** The version and system for GitHub's bug form. */
  async issueDetails() {
    return issueDetailsSchema.parse(await invoke("diagnostics_issue_details"));
  },
  /**
   * Writes the redacted report to `destination`, then ends the open report. A report that
   * cannot be written stays open. Nothing is sent anywhere.
   */
  async saveReport(destination: string) {
    return exportedSchema.parse(
      await invoke("diagnostics_save_report", { destination }),
    );
  },
};
