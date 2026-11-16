import { useDialogPresence } from "@/components/ui/use-dialog-presence";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Disclosure } from "@/components/ui/disclosure";
import { FailureAlert } from "@/components/ui/failure-alert";
import { PathText } from "@/components/ui/path-text";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
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
/** The footer note while the review is open: the safety net, then the one ask. */
const SAFETY_NOTE =
  "A safety backup of this workspace is saved first. Pause ticketd commands until it finishes.";

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

/** Why a chosen file cannot be restored: a title without a period, one sentence. */
function problem(inspection: BackupInspection) {
  const { check } = inspection;
  switch (check.status) {
    case "newer_format":
      return {
        title: "Saved by a newer ticketd",
        detail: `It uses workspace format ${check.backup_version}; this app reads up to ${check.supported_version}. Update ticketd, then try again.`,
      };
    case "not_ticketd":
      return {
        title: "Not a ticketd backup",
        detail:
          "Choose a file made with Back up now or the ticketd backup command.",
      };
    case "missing_tables":
      return {
        title: "This backup is incomplete",
        detail: `It is missing tables ticketd needs: ${check.tables.join(", ")}.`,
      };
    case "current_workspace":
      return {
        title: "This is the current workspace",
        detail:
          "Restoring a file over itself would change nothing. Choose a backup file instead.",
      };
    case "damaged":
      return {
        title: "This backup is damaged",
        detail: `It failed ticketd's checks: ${check.reason}.`,
      };
    case "valid":
      return null;
  }
}

/** This workspace beside the backup, at 14/20; a value that differs is weight 500. */
function Comparison({
  current,
  backup,
}: {
  current: WorkspaceSummary | null;
  backup: WorkspaceSummary | null;
}) {
  const cell = (summary: WorkspaceSummary | null, value: () => string) =>
    summary ? value() : <Skeleton className="h-2.5 w-12" />;
  return (
    <table className="restore-compare">
      <caption className="sr-only">
        This workspace compared with the backup. Document counts include
        supporting details and Trash.
      </caption>
      <thead>
        <tr>
          <td />
          <th scope="col">This workspace</th>
          <th scope="col">Backup</th>
        </tr>
      </thead>
      <tbody>
        {COUNTS.map(([key, label]) => (
          <tr key={key}>
            <th scope="row">{label}</th>
            <td>{cell(current, () => String(current?.[key]))}</td>
            <td
              data-differs={
                current && backup ? backup[key] !== current[key] : undefined
              }
            >
              {cell(backup, () => String(backup?.[key]))}
            </td>
          </tr>
        ))}
        <tr>
          <th scope="row">
            <Tooltip content={LAST_CHANGE}>
              <span tabIndex={0} aria-description={LAST_CHANGE}>
                Last change
              </span>
            </Tooltip>
          </th>
          <td>
            {cell(current, () => formatWhen(current?.last_change ?? null))}
          </td>
          <td
            data-differs={
              current && backup
                ? backup.last_change !== current.last_change
                : undefined
            }
          >
            {cell(backup, () => formatWhen(backup?.last_change ?? null))}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Reviews a backup before it replaces the workspace (DESIGN section 10): the
 * consequence first as an attention notice, then this workspace beside the
 * backup, then attachment details behind one disclosure. The footer says a
 * safety backup comes first; the destructive primary names the result. A file
 * that cannot be restored hides it and offers another file instead. Nothing
 * changes until Replace workspace is chosen. Opens with a file already picked.
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
  const presence = useDialogPresence(onClose);
  const [file, setFile] = useState(path);
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [revealFailure, setRevealFailure] = useState<FailureDescription | null>(
    null,
  );
  const latest = useRef(0);
  const recovery = useDraftRecovery();
  const attachmentDetails = useRef<HTMLDivElement>(null);

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

  async function reveal(target: string) {
    try {
      await workspaceClient.reveal(target);
      setRevealFailure(null);
    } catch (reason) {
      setRevealFailure(
        describeFailure(reason, `show the file in ${fileManagerName()}`),
      );
    }
  }

  const done = phase.name === "done";
  const inspection =
    phase.name === "review" || phase.name === "restoring"
      ? phase.inspection
      : null;
  const valid =
    inspection && inspection.check.status === "valid" ? inspection.check : null;
  const issue = inspection ? problem(inspection) : null;
  const { name } = splitPath(file);
  const manager = fileManagerName();
  const attachments = inspection?.attachment_content;

  // A file that cannot be restored offers the way forward, not a dead button.
  const invalid = phase.name === "unreadable" || issue !== null;
  return (
    <DialogShell
      {...presence.dialog}
      size="lg"
      busy={phase.name === "restoring"}
      title={
        done
          ? "Workspace restored"
          : invalid
            ? "Review backup"
            : "Replace this workspace?"
      }
      bodyBoundary="divider"
      description={
        done
          ? "The workspace now matches the backup."
          : `${name}. Nothing changes until you replace the workspace.`
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
              primaryLabel: "Choose another file…",
              blockedReason: null,
              onSubmit: () => void chooseAnother(),
            }
          : {
              primaryLabel:
                phase.name === "restoring" ? "Replacing…" : "Replace workspace",
              primaryVariant: "destructive" as const,
              blockedReason:
                phase.name === "checking"
                  ? "Checking the backup…"
                  : phase.name === "restoring"
                    ? SAFETY_NOTE
                    : null,
              footerNote: SAFETY_NOTE,
              onSubmit: () => inspection && void replace(inspection),
            })}
      {...((failure ?? revealFailure) && {
        error: (
          <FailureAlert
            size="compact"
            failure={(failure ?? revealFailure) as FailureDescription}
          />
        ),
      })}
    >
      {/* A file that can't be restored: the reason first, the fix is the primary. */}
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

      {/* The consequence first, then the comparison. Checking reserves the
          same layout, so the dialog does not grow when the check returns. */}
      {(phase.name === "checking" || valid) && (
        <>
          <Alert tone="attention" role="note">
            <AlertTitle>This replaces everything in this workspace</AlertTitle>
            <AlertDescription>
              Including follows, reminders and inbox state.
              {valid &&
                inspection &&
                ` ${differences(inspection.current, valid.summary)}`}
            </AlertDescription>
          </Alert>
          <Comparison
            current={inspection?.current ?? null}
            backup={valid?.summary ?? null}
          />
        </>
      )}

      {!done && (
        <div className="restore-file">
          <span className="restore-file-path" aria-label="Chosen backup file">
            <PathText path={file} />
          </span>
          {valid && (
            <StatusLabel tone="checked" size="caption">
              Integrity checked · format {valid.format_version}
            </StatusLabel>
          )}
          {phase.name === "checking" && (
            <span role="status" className="restore-muted">
              Checking the backup…
            </span>
          )}
          {!invalid && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={phase.name !== "review"}
              onClick={() => void chooseAnother()}
            >
              Choose another…
            </Button>
          )}
        </div>
      )}

      {valid && attachments && (
        <Disclosure
          label="Attachment details"
          onOpenChange={(open) => {
            if (open)
              requestAnimationFrame(() =>
                attachmentDetails.current?.scrollIntoView({ block: "nearest" }),
              );
          }}
        >
          <div
            ref={attachmentDetails}
            className="restore-attachments"
            aria-label="Attachment completeness"
          >
            <p>
              Local attachment files in the backup are complete:{" "}
              {attachments.local_snapshots}{" "}
              {attachments.local_snapshots === 1 ? "file" : "files"} on this
              computer; {attachments.retained_files} retained{" "}
              {attachments.retained_files === 1 ? "file" : "files"},{" "}
              {attachments.retained_bytes.toLocaleString()} bytes. Includes
              unused files, files in Trash, and retained quarantine.
            </p>
            <p>
              {attachments.remote_references}{" "}
              {attachments.remote_references === 1 ? "file" : "files"} in Google
              Drive: links and their details only. Files in Google Drive and
              account sign-ins are not backed up.
            </p>
            {attachments.remote_references > 0 && (
              <p>
                Restoring does not check Google Drive access. If a file is
                unavailable, connect the account and choose the file again in
                the attachment picker's Google Drive tab. Names and links are
                kept.
              </p>
            )}
          </div>
        </Disclosure>
      )}

      {phase.name === "done" && phase.inspection.check.status === "valid" && (
        <div role="status" className="restore-done">
          <p>
            You're now working from the backup:{" "}
            {phase.inspection.check.summary.tickets} tickets,{" "}
            {phase.inspection.check.summary.activities} activities.
          </p>
          <div className="restore-safety">
            <span className="restore-safety-text">
              <span className="restore-safety-label">
                Safety backup of the previous workspace
              </span>
              <PathText path={phase.safetyPath} />
            </span>
            {/* Show in Finder is the footer's primary. */}
            <CopyButton
              text={phase.safetyPath}
              label="Copy path"
              subject={phase.safetyPath}
            />
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
              Open tickets and views were reloaded from the restored workspace.
            </p>
          )}
        </div>
      )}
    </DialogShell>
  );
}
