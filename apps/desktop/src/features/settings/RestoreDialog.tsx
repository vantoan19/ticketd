import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  Copy,
  Database,
  FolderOpen,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { client } from "@/lib/api/client";
import {
  workspaceClient,
  type BackupInspection,
  type WorkspaceSummary,
} from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { writeClipboard } from "@/lib/clipboard";
import { revealFile } from "@/lib/reveal";
import "@/features/settings/restore-review.css";

type Phase =
  | { name: "checking" }
  | { name: "review"; inspection: BackupInspection }
  | { name: "unreadable"; reason: string }
  | { name: "restoring"; inspection: BackupInspection }
  | {
      name: "done";
      inspection: BackupInspection;
      safetyPath: string;
      reloadFailure: string;
    };

const UNCHANGED = "Your workspace hasn't changed.";

function formatWhen(timestamp: string | null) {
  return timestamp ? formatDateTime(timestamp) : "No changes yet";
}

function splitPath(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0
    ? { folder: "", name: path }
    : {
        folder: path.slice(0, cut) || path.slice(0, 1),
        name: path.slice(cut + 1),
      };
}

const COUNTS = [
  ["tickets", "Tickets", "ticket", "tickets"],
  ["notes", "Notes", "note", "notes"],
  ["evidence", "Implementation evidence", "evidence item", "evidence items"],
  ["projects", "Projects", "project", "projects"],
  ["efforts", "Efforts", "Effort", "Efforts"],
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
        This workspace compared with the backup
      </caption>
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Item</span>
          </th>
          <th scope="col">This workspace</th>
          <th scope="col">Backup</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">Last change</th>
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
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState("");
  const latest = useRef(0);

  const check = useCallback(async (next: string) => {
    const request = ++latest.current;
    let result: Phase;
    try {
      result = {
        name: "review",
        inspection: await workspaceClient.inspectBackup(next),
      };
    } catch (reason) {
      result = { name: "unreadable", reason: String(reason) };
    }
    if (request === latest.current) setPhase(result);
  }, []);
  function inspect(next: string) {
    setFile(next);
    setFailure("");
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
      setFailure(`Could not open the file dialog: ${String(reason)}`);
    }
  }

  async function replace(inspection: BackupInspection) {
    setFailure("");
    setPhase({ name: "restoring", inspection });
    let safetyPath: string;
    try {
      safetyPath = await client.restoreWorkspace(file);
    } catch (reason) {
      setPhase({ name: "review", inspection });
      setFailure(`Restore failed: ${String(reason)}`);
      return;
    }
    let reloadFailure = "";
    try {
      await onRestored();
    } catch (reason) {
      reloadFailure = `The restore finished, but open views could not reload: ${String(reason)}. Restart ticketd to see the restored data.`;
    }
    setPhase({ name: "done", inspection, safetyPath, reloadFailure });
  }

  async function copy(text: string) {
    const failure = await writeClipboard(text);
    setCopied(
      failure === null ? "Path copied." : `Could not copy the path: ${failure}`,
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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && phase.name !== "restoring") onClose();
      }}
    >
      <DialogContent
        className="restore-dialog sm:max-w-[600px]"
        showCloseButton={phase.name !== "restoring"}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="restore-head">
          <DialogTitle>Restore from a backup</DialogTitle>
          <DialogDescription>
            {done
              ? "The workspace now matches the backup."
              : "Check what you're restoring. Nothing changes until you replace the workspace."}
          </DialogDescription>
        </div>

        <div className="restore-body">
          <div className="restore-file">
            <Database aria-hidden="true" />
            <span className="restore-file-text">
              <code aria-label="Chosen backup file">{name}</code>
              <span aria-label="Backup folder">{folder}</span>
            </span>
            {!done && (
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
            <p role="alert" className="restore-problem">
              <CircleAlert aria-hidden="true" />
              <span>
                <strong>This file could not be read.</strong>
                <span>
                  {phase.reason} {UNCHANGED}
                </span>
              </span>
            </p>
          )}

          {issue && (
            <p role="alert" className="restore-problem">
              <CircleAlert aria-hidden="true" />
              <span>
                <strong>{issue.title}</strong>
                <span>
                  {issue.detail} {UNCHANGED}
                </span>
              </span>
            </p>
          )}

          {valid && inspection && (
            <>
              <p className="restore-checked">
                <StatusDot tone="checked" />
                <span>
                  <strong>Backup checked.</strong>{" "}
                  <span className="restore-muted">
                    Workspace format version {valid.format_version}.
                  </span>
                </span>
              </p>
              <Comparison current={inspection.current} backup={valid.summary} />
              <p className="restore-muted">
                Restoring replaces everything in this workspace, including
                follows, reminders, and inbox state.{" "}
                {differences(inspection.current, valid.summary)}
              </p>
              <div className="restore-notes">
                <p>
                  <strong>A safety backup comes first.</strong>{" "}
                  <span className="restore-muted">
                    ticketd saves a backup of this workspace next to it before
                    replacing anything. Restore that backup the same way to
                    undo.
                  </span>
                </p>
                <p>
                  <strong>Pause ticketd CLI commands.</strong>{" "}
                  <span className="restore-muted">
                    Stop other ticketd commands, such as an agent recording
                    notes, until the restore finishes.
                  </span>
                </p>
              </div>
            </>
          )}

          {phase.name === "done" &&
            phase.inspection.check.status === "valid" && (
              <div role="status" className="restore-done">
                <p className="restore-checked">
                  <StatusDot tone="checked" />
                  <span>
                    <strong>Workspace restored.</strong>{" "}
                    <span className="restore-muted">
                      You're now working from the backup:{" "}
                      {phase.inspection.check.summary.tickets} tickets,{" "}
                      {phase.inspection.check.summary.notes} notes.
                    </span>
                  </span>
                </p>
                <div className="restore-notes">
                  <p>
                    <strong>Safety backup of the previous workspace</strong>
                  </p>
                  <code aria-label="Safety backup path">
                    {phase.safetyPath}
                  </code>
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void reveal(phase.safetyPath)}
                    >
                      <FolderOpen aria-hidden="true" />
                      Show in {manager}
                    </Button>
                  </div>
                </div>
                {phase.reloadFailure ? (
                  <p role="alert" className="restore-failure">
                    {phase.reloadFailure}
                  </p>
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

          {failure && (
            <p role="alert" className="restore-failure">
              {failure}
            </p>
          )}
        </div>

        <div className="restore-footer">
          <span className="restore-muted">
            {done
              ? "To undo, restore the safety backup from Settings."
              : valid
                ? "You can undo this with the safety backup."
                : "Choose a backup saved by this version or earlier."}
          </span>
          {done ? (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          ) : (
            <span className="restore-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={phase.name === "restoring"}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!valid || phase.name === "restoring"}
                onClick={() => inspection && void replace(inspection)}
              >
                <RotateCcw aria-hidden="true" />
                {phase.name === "restoring"
                  ? "Restoring…"
                  : "Replace workspace"}
              </Button>
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
