import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  CircleAlert,
  FolderOpen,
  Loader2,
  Minus,
} from "lucide-react";
import { client } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient, type BackupRecord } from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import { fileManagerName } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { revealFile } from "@/lib/reveal";
import { PathText } from "@/components/ui/path-text";
import { lineFailure, localDate } from "@/features/settings/settings-format";
import { RestoreDialog } from "@/features/settings/RestoreDialog";
import { SafetyBackups } from "@/features/settings/SafetyBackups";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import "@/features/settings/restore-review.css";

type LastBackup =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; record: BackupRecord | null };

const CONTAINS = [
  {
    title: "The whole workspace",
    detail: "Tickets, Documents, Plans, Projects, activity and evidence",
    included: true,
  },
  {
    title: "Local attachment files",
    detail: "Every retained file stored on this computer",
    included: true,
  },
  {
    title: "Files in Google Drive",
    detail: "Kept as references and metadata, not copied",
    included: false,
  },
  {
    title: "An integrity check",
    detail: "Run on the saved copy before it is marked Checked",
    included: true,
  },
] as const;

function LastBackupRow({
  last,
  busy,
  onBackUp,
  onRetry,
  onReveal,
}: {
  last: LastBackup;
  busy: boolean;
  onBackUp: () => void;
  onRetry: () => void;
  onReveal: (path: string) => void;
}) {
  const backUp = (
    <Button
      type="button"
      disabled={busy || last.status === "loading"}
      onClick={onBackUp}
    >
      {busy ? "Backing up…" : "Back up now…"}
    </Button>
  );
  if (busy)
    return (
      <div role="status">
        <SettingsRow
          leading={
            <SettingsRowTile>
              <Loader2 size={20} className="animate-spin" />
            </SettingsRowTile>
          }
          title="Backing up…"
          description="Copying the workspace and its local attachment files, then checking the copy."
          trailing={backUp}
        />
      </div>
    );
  if (last.status === "loading")
    return (
      <div role="status" aria-label="Checking for the last backup">
        <SettingsRow
          leading={<SettingsRowTile>{null}</SettingsRowTile>}
          trailing={backUp}
        >
          <Skeleton className="h-2.5 w-45" />
          <Skeleton className="mt-2 h-2 w-70" />
        </SettingsRow>
      </div>
    );
  if (last.status === "failed")
    return (
      <div role="alert">
        <SettingsRow
          leading={
            <SettingsRowTile>
              <CircleAlert size={20} className="backups-icon-error" />
            </SettingsRowTile>
          }
          title="Couldn't read the last backup"
          description="The backups themselves are fine. Retry, or back up now."
          trailing={
            <>
              <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
                Retry
              </Button>
              {backUp}
            </>
          }
        />
      </div>
    );
  if (!last.record)
    return (
      <SettingsRow
        leading={
          <SettingsRowTile>
            <Archive size={20} className="backups-icon-muted" />
          </SettingsRowTile>
        }
        title="No backups yet"
        description="Your first backup will be listed here with its date."
        trailing={backUp}
      />
    );
  const { record } = last;
  return (
    <SettingsRow
      leading={
        <SettingsRowTile>
          <Archive size={20} />
        </SettingsRowTile>
      }
      title={
        <span className="backups-title-line">
          {formatDateTime(record.completed_at)}
          <StatusLabel tone="checked" size="caption">
            Checked
          </StatusLabel>
        </span>
      }
      description={
        // The file name whole on its own line; the folder under it gives way
        // in the middle, with the full path on hover.
        <span className="backups-last-path">
          <PathText path={record.path} />
        </span>
      }
      trailing={
        <>
          <IconButton
            label={`Show in ${fileManagerName()}`}
            onClick={() => onReveal(record.path)}
          >
            <FolderOpen aria-hidden="true" />
          </IconButton>
          {backUp}
        </>
      }
    />
  );
}

function BackupsContent({ onRestore }: { onRestore: () => Promise<void> }) {
  const [last, setLast] = useState<LastBackup>({ status: "loading" });
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const choosing = useRef(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState(0);
  const loadLast = useCallback(async () => {
    setLast({ status: "loading" });
    try {
      setLast({ status: "ready", record: await workspaceClient.lastBackup() });
    } catch {
      setLast({ status: "failed" });
    }
  }, []);
  useEffect(() => {
    // The initial read: state starts as "loading", so only the result is set.
    let current = true;
    workspaceClient
      .lastBackup()
      .then((record) => {
        if (current) setLast({ status: "ready", record });
      })
      .catch(() => {
        if (current) setLast({ status: "failed" });
      });
    return () => {
      current = false;
    };
  }, []);
  async function backUp() {
    // Only one save sheet at a time; the row says nothing until a path returns.
    if (choosing.current) return;
    choosing.current = true;
    setFailure(null);
    setMessage("");
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Back up ticketd workspace",
        defaultPath: `ticketd-backup-${localDate()}.sqlite3`,
        filterName: "ticketd backup",
        extension: "sqlite3",
      });
      if (path === null) return;
      setBusy(true);
      let recorded: boolean;
      try {
        recorded = await client.backupWorkspace(path);
      } catch (reason) {
        // The core says what happened, such as an existing file at the path.
        setFailure(describeFailure(reason, "save the backup"));
        return;
      }
      setMessage(
        recorded
          ? "Backup saved and checked."
          : "Backup saved and checked, but the Last backup status could not be updated.",
      );
      try {
        setLast({
          status: "ready",
          record: await workspaceClient.lastBackup(),
        });
      } catch {
        // Keep the previous status; the backup itself succeeded.
      }
    } catch (reason) {
      setFailure(describeFailure(reason, "open the save dialog"));
    } finally {
      choosing.current = false;
      setBusy(false);
    }
  }
  async function reveal(path: string) {
    const failure = await revealFile(path);
    if (failure) setFailure(lineFailure(failure));
  }
  async function chooseBackup() {
    setFailure(null);
    try {
      const path = await workspaceClient.chooseBackupFile({
        title: "Choose a ticketd backup",
      });
      if (path !== null) setRestoring(path);
    } catch (reason) {
      setFailure(describeFailure(reason, "open the file dialog"));
    }
  }
  return (
    <>
      <SettingsSection title="Last backup">
        <SettingsList>
          <LastBackupRow
            last={last}
            busy={busy}
            onBackUp={() => void backUp()}
            onRetry={() => void loadLast()}
            onReveal={(path) => void reveal(path)}
          />
          <SettingsListFooter>
            Each backup goes to a new file you choose. A backup never replaces
            an existing file.
            {failure && <FailureAlert size="compact" failure={failure} />}
            <p role="status" className="backups-message">
              {message}
            </p>
          </SettingsListFooter>
        </SettingsList>
      </SettingsSection>

      <SettingsSection title="What a backup contains">
        <SettingsList>
          <ul className="backups-contains">
            {CONTAINS.map((item) => (
              <li key={item.title}>
                {item.included ? (
                  <Check size={16} aria-hidden="true" className="included" />
                ) : (
                  <Minus size={16} aria-hidden="true" className="excluded" />
                )}
                <span>
                  <span className="backups-contains-title">{item.title}</span>
                  <span className="backups-contains-detail">{item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </SettingsList>
      </SettingsSection>

      <SettingsSection
        title="Restore"
        caption="Replaces this workspace with a backup. You review what it contains first, and a safety backup of the current workspace is saved before anything changes."
      >
        <SettingsList>
          <SettingsRow
            title="Restore from a backup"
            description="Choose a backup file saved by this version of ticketd or an earlier one."
            trailing={
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void chooseBackup()}
              >
                Choose backup…
              </Button>
            }
          />
        </SettingsList>
      </SettingsSection>

      <SafetyBackups key={restoredCount} />

      {restoring !== null && (
        <RestoreDialog
          path={restoring}
          onClose={() => setRestoring(null)}
          onRestored={async () => {
            setRestoredCount((count) => count + 1);
            await loadLast();
            await onRestore();
          }}
        />
      )}
    </>
  );
}

export function BackupsPage({ onRestore }: { onRestore: () => Promise<void> }) {
  return (
    <SettingsPage
      {...sectionMeta("backups")}
      lede="Complete copies of this workspace, checked after they are saved, that you can restore later."
    >
      <BackupsContent onRestore={onRestore} />
    </SettingsPage>
  );
}
