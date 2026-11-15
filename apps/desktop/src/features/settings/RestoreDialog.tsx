import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Database, ShieldCheck, Terminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { client } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  workspaceClient,
  type BackupInspection,
  type WorkspaceSummary,
} from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { writeClipboard } from "@/lib/clipboard";
import { revealFile } from "@/lib/reveal";
import { splitPath } from "@/features/settings/settings-format";
import { useDraftRecovery } from "@/lib/draft-recovery-context";
import "@/features/settings/restore-review.css";

type Phase =
  | { name: "checking" }
  | { name: "review"; inspection: BackupInspection }
  | { name: "unreadable"; failure: FailureDescription }
  | { name: "restoring"; inspection: BackupInspection }
  | {
      name: "done";
      inspection: BackupInspection;
      safetyPath: string;
      /** What could not be confirmed around a restore that did happen. */
      warning: string;
      reloadFailure: FailureDescription | null;
    };

const UNCHANGED = "Your workspace hasn't changed.";
const LAST_CHANGE =
  "The latest ticket history, Activity, Document, or evidence change. Some other edits are not dated.";

function formatWhen(timestamp: string | null) {
  return timestamp ? formatDateTime(timestamp) : "No changes yet";
}

const COUNTS = [
  ["tickets", "Tickets", "ticket", "tickets"],
  [
    "documents",
    "Documents (including details and Trash)",
    "Document",
    "Documents",
  ],
  ["activities", "Activities", "activity", "activities"],
  ["evidence", "Implementation evidence", "evidence item", "evidence items"],
  ["projects", "Projects", "project", "projects"],
  ["plans", "Plans", "Plan", "Plans"],
] as const;

/** "The backup has 7 fewer tickets and 19 fewer notes." or a statement that counts match. */
function differences(current: WorkspaceSummary, backup: WorkspaceSummary) {
  const parts = COUNTS.flatMap(([key, , one, many]) => {
    const change = backup[key] - current[key];
    if (change === 0) return [];
    const size = Math.abs(change);
    return [
      `${size} ${change < 0 ? "fewer" : "more"} ${size === 1 ? one : many}`,
    ];
  });
  if (parts.length === 0)
    return "The backup has the same counts as this workspace.";
  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `The backup has ${joined}.`;
}

function problem(inspection: BackupInspection) {
  const { check } = inspection;
  switch (check.status) {
    case "newer_format":
      return {
        title: "This backup can't be restored by this version.",
        detail: `It was saved by a newer ticketd (workspace format ${check.backup_version}; this app reads up to ${check.supported_version}). Update ticketd, then try again.`,
      };
    case "not_ticketd":
      return {
        title: "This isn't a ticketd backup.",
        detail:
          "The file isn't a ticketd workspace. Choose a file saved with Back up now… or ticketd backup.",
      };
    case "missing_tables":
      return {
        title: "This backup is incomplete.",
        detail: `It is missing tables ticketd needs: ${check.tables.join(", ")}.`,
      };
    case "current_workspace":
      return {
        title: "This is the current workspace.",
        detail:
          "Restoring a file over itself would change nothing. Choose a backup file instead.",
      };
    case "damaged":
      return {
        title: "This backup is damaged.",
        detail: `It failed ticketd's checks: ${check.reason}.`,
      };
    case "valid":
      return null;
  }
}

function Comparison({
  current,
  backup,
}: {
  current: WorkspaceSummary;
  backup: WorkspaceSummary;
}) {
  return (
    <table className="restore-compare">
      <caption className="sr-only">
        This workspace compared with the backup. Document counts include
        supporting details and Trash.
      </caption>
      <thead>
        <tr>
          <th scope="col">Replaces</th>
          <th scope="col">Current workspace</th>
          <th scope="col">This backup</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">
            <Tooltip content={LAST_CHANGE}>
              <span tabIndex={0} aria-description={LAST_CHANGE}>
                Last recorded change
              </span>
            </Tooltip>
          </th>
          <td>{formatWhen(current.last_change)}</td>
          <td>{formatWhen(backup.last_change)}</td>
        </tr>
        {COUNTS.map(([key, label]) => (
          <tr key={key}>
            <th scope="row">{label}</th>
            <td>{current[key]}</td>
            <td data-differs={backup[key] !== current[key]}>{backup[key]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Reviews a backup before it replaces the workspace. Nothing changes until
 * Replace workspace is chosen. Opens only with a file already picked.
 */
export function RestoreDialog({
  path,
  onClose,
  onRestored,
}: {
  path: string;
  onClose: () => void;
  /** Reloads open views from the restored workspace. */
  onRestored: () => Promise<void>;
}) {
  const [file, setFile] = useState(path);
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [copied, setCopied] = useState("");
  const latest = useRef(0);
  const recovery = useDraftRecovery();

  const check = useCallback(async (next: string) => {
    const request = ++latest.current;
    let result: Phase;
    try {
      result = {
        name: "review",
        inspection: await workspaceClient.inspectBackup(next),
      };
    } catch (reason) {
      result = {
        name: "unreadable",
        failure: describeFailure(reason, "read this backup"),
      };
    }
    if (request === latest.current) setPhase(result);
  }, []);
  function inspect(next: string) {
    setFile(next);
    setFailure(null);
    setPhase({ name: "checking" });
    return check(next);
  }
  // The dialog starts in "checking", so only the result is set from here.
  useEffect(() => {
    void check(path);
  }, [check, path]);

  async function chooseAnother() {
    try {
      const next = await workspaceClient.chooseBackupFile({
        title: "Choose a ticketd backup",
      });
      if (next !== null) await inspect(next);
    } catch (reason) {
      setFailure(describeFailure(reason, "open the file dialog"));
    }
  }

  async function replace(inspection: BackupInspection) {
    setFailure(null);
    setPhase({ name: "restoring", inspection });
    let safetyPath: string;
    let warning: string;
    try {
      await recovery.flush();
      const restored = await client.restoreWorkspace(file);
      safetyPath = restored.safety_path;
      warning = restored.warning ?? "";
    } catch (reason) {
      setPhase({ name: "review", inspection });
      const failed = describeFailure(reason, "restore the backup");
      setFailure({ ...failed, sentence: `${failed.sentence} ${UNCHANGED}` });
      return;
    }
    let reloadFailure: FailureDescription | null = null;
    try {
      await recovery.reloadAfterRestore();
      await onRestored();
    } catch (reason) {
      reloadFailure = {
        ...describeFailure(reason, "reload open views"),
        action: null,
        sentence:
          "The restore finished. Restart ticketd to see the restored data.",
      };
    }
    setPhase({ name: "done", inspection, safetyPath, warning, reloadFailure });
  }

  async function copy(text: string) {
    const failure = await writeClipboard(text);
    setCopied(
      failure === null ? "Path copied." : `Couldn't copy the path: ${failure}.`,
    );
  }
  async function reveal(target: string) {
    setCopied((await revealFile(target)) ?? "");
  }

  const busy = phase.name === "restoring" || phase.name === "checking";
  const done = phase.name === "done";
  const inspection =
    phase.name === "review" || phase.name === "restoring"
      ? phase.inspection
      : null;
  const valid =
    inspection && inspection.check.status === "valid" ? inspection.check : null;
  const issue = inspection ? problem(inspection) : null;
  const { folder, name } = splitPath(file);
  const manager = fileManagerName();

  // A file that cannot be restored offers the way forward, not a dead button.
  const invalid = phase.name === "unreadable" || issue !== null;
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      busy={phase.name === "restoring"}
      title="Restore from backup"
      description={
        done
          ? "The workspace now matches the backup."
          : "Check what this backup contains. Nothing changes until you confirm."
      }
      {...(done
        ? {
            primaryLabel: `Show in ${manager}`,
            cancelLabel: "Done",
            showClose: false,
            blockedReason: null,
            footerNote: "To undo, restore the safety backup from Settings.",
            onSubmit: () => void reveal(phase.safetyPath),
          }
        : invalid
          ? {
              primaryLabel: "Choose another…",
              blockedReason: null,
              footerNote: "Choose a backup saved by this version or earlier.",
              onSubmit: () => void chooseAnother(),
            }
          : {
              primaryLabel: "Replace workspace with backup",
              primaryVariant: "destructive" as const,
              blockedReason:
                phase.name === "checking"
                  ? "Checking the backup…"
                  : phase.name === "restoring"
                    ? "Restoring…"
                    : null,
              onSubmit: () => inspection && void replace(inspection),
            })}
      {...(failure && {
        error: <FailureAlert size="compact" failure={failure} />,
      })}
    >
      {/* Focusable so End, Page Down and the arrow keys scroll the review; focus is otherwise on the buttons outside it. */}
      <div
        className="restore-body"
        role="region"
        aria-label="Backup review"
        tabIndex={0}
      >
        <div className="restore-file">
          <span className="restore-file-tile" aria-hidden="true">
            <Database />
          </span>
          <span className="restore-file-text">
            <code aria-label="Chosen backup file">{name}</code>
            <span>
              <Tooltip content={folder} overflowOnly>
                <span aria-label="Backup folder">{folder}</span>
              </Tooltip>
              {valid && (
                <span className="restore-file-check">
                  {" · "}
                  <StatusLabel tone="checked" size="caption">
                    Integrity checked · format version {valid.format_version}
                  </StatusLabel>
                </span>
              )}
            </span>
          </span>
          {!done && !invalid && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void chooseAnother()}
            >
              Choose another…
            </Button>
          )}
        </div>

        {phase.name === "checking" && (
          <p role="status" className="restore-muted">
            Checking the backup…
          </p>
        )}

        {phase.name === "unreadable" && (
          <FailureAlert
            failure={{
              ...phase.failure,
              sentence: `${phase.failure.sentence} ${UNCHANGED}`,
            }}
          />
        )}

        {issue && (
          <Alert tone="error">
            <AlertTitle>{issue.title}</AlertTitle>
            <AlertDescription>
              {issue.detail} {UNCHANGED}
            </AlertDescription>
          </Alert>
        )}

        {valid && inspection && (
          <>
            <Comparison current={inspection.current} backup={valid.summary} />
            <p>
              {differences(inspection.current, valid.summary)} Restoring
              replaces everything in this workspace, including follows,
              reminders and inbox state.
              {inspection.attachment_content &&
                " Local attachment bytes in the backup are complete."}
            </p>
            {inspection.attachment_content && (
              <div
                className="restore-attachments"
                aria-label="Attachment completeness"
              >
                <p>
                  {inspection.attachment_content.local_snapshots} local{" "}
                  {inspection.attachment_content.local_snapshots === 1
                    ? "snapshot"
                    : "snapshots"}
                  ; {inspection.attachment_content.retained_files} retained{" "}
                  {inspection.attachment_content.retained_files === 1
                    ? "file"
                    : "files"}
                  ,{" "}
                  {inspection.attachment_content.retained_bytes.toLocaleString()}{" "}
                  bytes. Includes unused files, files in Trash, and retained
                  quarantine.
                </p>
                <p>
                  {inspection.attachment_content.remote_references} remote{" "}
                  {inspection.attachment_content.remote_references === 1
                    ? "reference"
                    : "references"}
                  : links and metadata only. Remote file bytes and account
                  credentials are not backed up.
                </p>
                {inspection.attachment_content.remote_references > 0 && (
                  <p>
                    Restoring does not verify Drive access. If unavailable,
                    connect the appropriate account and select the file again in
                    the attachment picker's Google Drive tab. Last-known names
                    and references are preserved.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {phase.name === "done" && phase.inspection.check.status === "valid" && (
          <div role="status" className="restore-done">
            <p className="restore-checked">
              <StatusDot tone="checked" />
              <span>
                <strong>Workspace restored.</strong>{" "}
                <span className="restore-muted">
                  You're now working from the backup:{" "}
                  {phase.inspection.check.summary.tickets} tickets,{" "}
                  {phase.inspection.check.summary.activities} activities.
                </span>
              </span>
            </p>
            <div className="restore-notes">
              <p>
                <strong>Safety backup of the previous workspace</strong>
              </p>
              <code aria-label="Safety backup path">{phase.safetyPath}</code>
              <div className="restore-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copy(phase.safetyPath)}
                >
                  <Copy aria-hidden="true" />
                  Copy path
                </Button>
              </div>
            </div>
            {phase.warning && (
              <Alert tone="attention" size="compact">
                <AlertDescription>{phase.warning}</AlertDescription>
              </Alert>
            )}
            {phase.reloadFailure ? (
              <FailureAlert size="compact" failure={phase.reloadFailure} />
            ) : (
              <p className="restore-muted">
                Open tickets and views were reloaded from the restored
                workspace.
              </p>
            )}
            <p role="status" className="restore-muted">
              {copied}
            </p>
          </div>
        )}
      </div>

      {valid && (
        <div className="restore-pinned">
          <div className="restore-pin">
            <ShieldCheck aria-hidden="true" />
            <span>
              <strong>A safety backup comes first</strong>
              <span>Restore that safety backup to undo.</span>
            </span>
          </div>
          <div className="restore-pin">
            <Terminal aria-hidden="true" />
            <span>
              <strong>Pause ticketd CLI commands</strong>
              <span>Agents should stop recording while the restore runs.</span>
            </span>
          </div>
        </div>
      )}
    </DialogShell>
  );
}
