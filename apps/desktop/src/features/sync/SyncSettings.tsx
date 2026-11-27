import { useEffect, useState } from "react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { PathText } from "@/components/ui/path-text";
import { RevealButton } from "@/components/ui/reveal-button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { type SyncStatus } from "@/lib/sync-api";
import { syncReview } from "@/lib/sync-review-api";
import { SyncFailure as Failure } from "./SyncFailure";
import { SyncConnected } from "./SyncConnected";
import { placeOf } from "./sync-words";
import { Choose, FirstSync, SyncSetup, type SetupIntent } from "./SyncSetup";
import { useSyncStatus } from "./sync-status";
import "@/features/settings/settings.css";
import "./sync.css";

const TRACK = ["Connect", "Choose a workspace", "First sync", "In sync"];

/**
 * The four stages of setup as one horizontal row of steps: numbered, a check
 * once done, the current one in primary. No status colour: the words say
 * where setup is (set ST-31).
 */
export function Track({ status }: { status: SyncStatus | null }) {
  const at = !status
    ? -1
    : status.connection === "not_connected"
      ? 0
      : status.connection === "choosing"
        ? 1
        : status.first_sync
          ? 2
          : 3;
  const synced = status?.connection === "connected" && !status.first_sync;
  return (
    <ol className="sync-track" aria-label="Sync setup">
      {TRACK.map((label, index) => {
        const state =
          index < at || synced ? "done" : index === at ? "now" : undefined;
        return (
          <li
            key={label}
            data-state={state}
            aria-current={index === at ? "step" : undefined}
          >
            <span className="sync-track-label">{label}</span>
            {index < at && <span className="sr-only">, done</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** One row in the shape of the Connect and Connected rows, while the status is read. */
function StatusSkeleton() {
  return (
    <div className="sync-block" role="status" aria-label="Reading Google Drive">
      <SettingsList>
        <SettingsRow
          leading={<Skeleton className="size-10" />}
          title={<Skeleton className="h-5 w-40" />}
          description={<Skeleton className="mt-1 h-4 w-72 max-w-full" />}
          trailing={<Skeleton className="h-8 w-40" />}
        />
      </SettingsList>
    </div>
  );
}

/** Settings › Workspace sync, for Google Drive: setup until this Workspace syncs, then its settings. The page shell supplies the title. */
export function SyncSettings({
  onReplaced,
}: {
  /** Called after a download replaced this Workspace, to drop what described the old one. */
  onReplaced: () => Promise<void>;
}) {
  const { status } = useSyncStatus();
  // Where the Workspace a download replaced was kept, while this page is open.
  const [safetyBackup, setSafetyBackup] = useState("");
  // What step 1 of setup said, kept while the person signs in and chooses.
  const [intent, setIntent] = useState<SetupIntent | null>(null);
  // Setup is over once this Workspace is connected: a later setup (after Disconnect) asks
  // again. Back from step 3 never reaches here, so it keeps the choice.
  const connected = status?.connection === "connected";
  useEffect(() => {
    if (connected) setIntent(null);
  }, [connected]);
  return (
    <div className="settings-sync">
      <Track status={status} />
      {/* While the first sync runs, its own footer says where the old Workspace is kept. */}
      {safetyBackup && !status?.first_sync && (
        <Replaced safetyBackup={plainPath(safetyBackup)} />
      )}
      {!status && <StatusSkeleton />}
      {status &&
        (status.connection === "not_connected" ? (
          <SyncSetup intent={intent} onIntent={setIntent} />
        ) : status.connection === "choosing" ? (
          <Choose
            // Another account has other storage: nothing read, chosen or confirmed for the old one stays.
            key={`${status.provider}:${status.account}`}
            status={status}
            intent={intent}
            onDownloaded={setSafetyBackup}
            onReplaced={onReplaced}
          />
        ) : // What stopped a first sync is shown with its action, not as progress standing still.
        status.first_sync && !status.recovery ? (
          <FirstSync status={status} progress={status.first_sync} />
        ) : (
          <SyncConnected status={status} />
        ))}
    </div>
  );
}

/** A path without Windows' internal `\\?\` prefix, which no person or file manager uses. */
const plainPath = (path: string) =>
  path.replace(/^\\\\\?\\(UNC\\)?/, (_, unc?: string) => (unc ? "\\\\" : ""));

/** Says where the Workspace a download replaced was kept: its file's name, and a way to it. */
function Replaced({ safetyBackup }: { safetyBackup: string }) {
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const { status } = useSyncStatus();
  const place = placeOf(status?.provider ?? "google_drive");
  // The confirmation counted every file in the storage; one that turned out
  // unreadable did not arrive. The replaced Workspace started with no notices,
  // so its unread ones of that kind are this download's.
  const [skipped, setSkipped] = useState(0);
  const downloading = !status || status.first_sync !== null;
  const syncedAt = status?.last_synced_at;
  useEffect(() => {
    if (downloading) return;
    let current = true;
    syncReview
      .notices()
      .then((notices) => {
        if (current)
          setSkipped(
            notices.filter(
              (notice) => notice.kind === "unreadable_file" && !notice.read,
            ).length,
          );
      })
      .catch(() => {
        // The Inbox still lists them; this line only points there.
      });
    return () => {
      current = false;
    };
    // Read again after each sync run: a file that reads now takes its notice back.
  }, [downloading, syncedAt]);
  return (
    <div className="sync-block">
      <Alert role="status">
        <AlertTitle>This Workspace was replaced</AlertTitle>
        <AlertDescription>
          A safety backup of the Workspace this computer had before is kept.
          <span className="sync-safety-path">
            <PathText path={safetyBackup} />
          </span>
          {skipped > 0 && (
            <span>
              {skipped === 1
                ? `1 file in ${place} could not be read and was skipped.`
                : `${skipped} files in ${place} could not be read and were skipped.`}{" "}
              See Inbox.
            </span>
          )}
        </AlertDescription>
        <AlertActions>
          <RevealButton path={safetyBackup} onFailure={setFailure} />
        </AlertActions>
        <Failure>{failure}</Failure>
      </Alert>
    </div>
  );
}
