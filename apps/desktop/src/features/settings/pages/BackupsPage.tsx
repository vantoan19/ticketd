import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Minus } from "lucide-react";
import { client } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient, type BackupRecord } from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { PathText } from "@/components/ui/path-text";
import { RevealButton } from "@/components/ui/reveal-button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import { formatDateTime } from "@/lib/format";
import { localDate } from "@/features/settings/settings-format";
import { RestoreDialog } from "@/features/settings/RestoreDialog";
import { SafetyBackups } from "@/features/settings/SafetyBackups";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import "@/features/settings/restore-review.css";

type LastBackup =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; record: BackupRecord | null };

/** What a backup holds, in words: the icons beside them stay neutral. */
const INCLUDED = [
  {
    title: "The whole workspace",
    detail: "Tickets, Documents, Plans, Projects, activity and evidence",
  },
  {
    title: "Local attachment files",
    detail: "Every retained file stored on this computer",
  },
  {
    title: "An integrity check",
    detail: "Run on the saved copy before it is marked Checked",
  },
] as const;
const NOT_INCLUDED = [
  {
    title: "Files in Google Drive",
    detail: "Kept as links and their details, not copied",
  },
] as const;

/** The first row: the last backup's file and its Checked status, or why there is none. */
function LastBackupRow({
  last,
  onRetry,
  onRevealFailure,
}: {
  last: LastBackup;
  onRetry: () => void;
  onRevealFailure: (failure: FailureDescription | null) => void;
}) {
  if (last.status === "loading")
    return (
      <div role="status" aria-label="Checking for the last backup">
        <SettingsRow title="Last backup">
          <Skeleton className="mt-1 h-2.5 w-60" />
          <Skeleton className="mt-1.5 h-2 w-40" />
        </SettingsRow>
      </div>
    );
  if (last.status === "failed")
    return (
      <div role="alert">
        <SettingsRow
          title={
            <StatusLabel tone="attention">
              Couldn't load the last backup
            </StatusLabel>
          }
          description="The backups themselves are fine."
          trailing={
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      </div>
    );
  if (!last.record)
    return (
      <SettingsRow
        title="No backups yet"
        description="Your first backup will be listed here with its date."
      />
    );
  const { record } = last;
  return (
    <SettingsRow
      title={
        <>
          Last backup
          <span className="backups-when">
            {" · "}
            {formatDateTime(record.completed_at)}
          </span>
        </>
      }
      // The file name whole on line one; the folder under it gives way in the
      // middle, with the full path on hover. The row keeps its height.
      description={<PathText path={record.path} />}
      trailing={
        <>
          <StatusLabel tone="checked" size="caption">
            Checked
          </StatusLabel>
          <RevealButton path={record.path} onFailure={onRevealFailure} />
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
      // The Last backup row's Checked says it; this line is for screen
      // readers, unless the row could not be updated.
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
  const quiet = message === "Backup saved and checked.";
  return (
    <>
      <div className="settings-section">
        <SettingsList aria-label="Backups" role="group">
          <LastBackupRow
            last={last}
            onRetry={() => void loadLast()}
            onRevealFailure={setFailure}
          />
          <SettingsRow
            title="Back up now"
            description={
              <span aria-live="polite">
                {busy
                  ? "Copying the workspace and its local attachment files, then checking the copy."
                  : "Saves a checked copy to a new file you choose. It never replaces an existing file."}
              </span>
            }
            trailing={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || last.status === "loading"}
                onClick={() => void backUp()}
              >
                {busy ? "Backing up…" : "Back up now…"}
              </Button>
            }
          />
          <SettingsRow
            title="Restore from a backup"
            description="Replaces this workspace after a review. A safety backup of it is saved first."
            trailing={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void chooseBackup()}
              >
                Choose backup…
              </Button>
            }
          />
          {(failure || (message && !quiet)) && (
            <SettingsListFooter>
              {failure ? (
                <FailureAlert size="compact" failure={failure} />
              ) : (
                message
              )}
            </SettingsListFooter>
          )}
        </SettingsList>
        <p role="status" className="sr-only">
          {quiet ? message : ""}
        </p>
      </div>

      <SettingsSection title="What a backup contains">
        <SettingsList>
          <div className="backups-contains">
            {[
              { heading: "Included", items: INCLUDED, Icon: Check },
              { heading: "Not included", items: NOT_INCLUDED, Icon: Minus },
            ].map(({ heading, items, Icon }) => (
              <div key={heading} className="backups-contains-column">
                <p className="backups-contains-heading">{heading}</p>
                <ul aria-label={heading}>
                  {items.map((item) => (
                    <li key={item.title}>
                      <Icon size={16} aria-hidden="true" />
                      <span>
                        <span className="backups-contains-title">
                          {item.title}
                        </span>
                        <span className="backups-contains-detail">
                          {item.detail}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </SettingsList>
      </SettingsSection>

      <SafetyBackups key={restoredCount} onRestore={setRestoring} />

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
      lede="Save a checked copy of this workspace, and restore one later."
    >
      <BackupsContent onRestore={onRestore} />
    </SettingsPage>
  );
}
