import { useEffect, useState } from "react";
import { ChevronDown, FolderOpen, Loader2 } from "lucide-react";
import { client } from "@/lib/api/client";
import { workspaceClient, type BackupRecord } from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { fileManagerName } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { revealFile } from "@/lib/reveal";
import { localDate } from "@/features/settings/settings-format";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { RestoreDialog } from "@/features/settings/RestoreDialog";
import { SafetyBackups } from "@/features/settings/SafetyBackups";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

function BackupsCard({ onRestore }: { onRestore: () => Promise<void> }) {
  const [last, setLast] = useState<BackupRecord | null>(null);
  const [failure, setFailure] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [showSafety, setShowSafety] = useState(false);
  const [restoredCount, setRestoredCount] = useState(0);
  const [safetyCount, setSafetyCount] = useState(0);
  useEffect(() => {
    let current = true;
    void Promise.resolve(workspaceClient.safetyBackups())
      .then((value) => {
        if (current && Array.isArray(value)) setSafetyCount(value.length);
      })
      .catch(() => {
        // The count is informational; the list reports its own failure.
      });
    return () => {
      current = false;
    };
  }, [restoredCount]);
  useEffect(() => {
    let current = true;
    workspaceClient
      .lastBackup()
      .then((value) => {
        if (current) setLast(value);
      })
      .catch(() => {
        // The status is informational; backing up still works without it.
      });
    return () => {
      current = false;
    };
  }, []);
  async function backUp() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Back up ticketd workspace",
        defaultPath: `ticketd-backup-${localDate()}.sqlite3`,
        filterName: "ticketd backup",
        extension: "sqlite3",
      });
      if (path === null) return;
      let recorded: boolean;
      try {
        recorded = await client.backupWorkspace(path);
      } catch (reason) {
        // The core says what happened, such as an existing file at the path.
        setFailure(`The backup was not saved: ${String(reason)}`);
        return;
      }
      setMessage(
        recorded
          ? "Backup saved and checked."
          : "Backup saved and checked, but the Last backup status could not be updated.",
      );
      try {
        setLast(await workspaceClient.lastBackup());
      } catch {
        // Keep the previous status; the backup itself succeeded.
      }
    } catch (reason) {
      setFailure(`Could not open the save dialog: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }
  async function reveal(path: string) {
    const failure = await revealFile(path);
    if (failure) setFailure(failure);
  }
  async function chooseBackup() {
    setFailure("");
    try {
      const path = await workspaceClient.chooseBackupFile({
        title: "Choose a ticketd backup",
      });
      if (path !== null) setRestoring(path);
    } catch (reason) {
      setFailure(`Could not open the file dialog: ${String(reason)}`);
    }
  }
  return (
    <SettingsCard
      id="backups"
      title="Backups"
      description="A complete copy of the workspace and every retained local attachment file, checked for integrity after it is saved. Remote files remain references and metadata. It never replaces an existing file."
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void backUp()}
        >
          {busy ? (
            <>
              <Loader2 aria-hidden="true" className="animate-spin" />
              Backing up…
            </>
          ) : (
            "Back up now…"
          )}
        </Button>
      }
    >
      <div className="backup-status" role="group" aria-label="Last backup">
        {last ? (
          <>
            <p className="settings-label">
              Last backup{" "}
              <span className="settings-hint">
                {formatDateTime(last.completed_at)}
              </span>
            </p>
            <p className="workspace-path" aria-label="Last backup path">
              {last.path}
            </p>
            <div className="settings-actions">
              <span className="status-word">
                <StatusDot tone="checked" />
                Checked
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void reveal(last.path)}
              >
                <FolderOpen aria-hidden="true" />
                Show in {fileManagerName()}
              </Button>
            </div>
          </>
        ) : (
          <p className="settings-hint">
            No backups yet. Your first one will be listed here with its date and
            size.
          </p>
        )}
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
      <p role="status" className="settings-hint">
        {message}
      </p>
      <div className="backup-restore-row">
        <div>
          <p className="settings-label">Restore from a backup</p>
          <p className="settings-hint">
            You review what the backup contains before anything changes.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void chooseBackup()}
        >
          Restore from backup…
        </Button>
      </div>
      <div className="backup-footer">
        <div className="backup-footer-row">
          <p className="settings-hint">
            Restoring saves a safety backup of the current workspace first.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="safety-toggle"
            aria-expanded={showSafety}
            onClick={() => setShowSafety((shown) => !shown)}
          >
            Safety backups · {safetyCount}
            <ChevronDown aria-hidden="true" data-open={showSafety} />
          </Button>
        </div>
        {showSafety && <SafetyBackups key={restoredCount} />}
      </div>
      {restoring !== null && (
        <RestoreDialog
          path={restoring}
          onClose={() => setRestoring(null)}
          onRestored={async () => {
            setRestoredCount((count) => count + 1);
            try {
              setLast(await workspaceClient.lastBackup());
            } catch {
              // The status is informational.
            }
            await onRestore();
          }}
        />
      )}
    </SettingsCard>
  );
}

export function BackupsPage({ onRestore }: { onRestore: () => Promise<void> }) {
  return (
    <SettingsPage
      {...sectionMeta("backups")}
      lede="Complete copies of this workspace, checked after they are saved, that you can restore later."
    >
      <BackupsCard onRestore={onRestore} />
    </SettingsPage>
  );
}
