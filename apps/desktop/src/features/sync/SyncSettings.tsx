import { useEffect, useRef, useState } from "react";
import { Cloud, Download, ExternalLink, Upload } from "lucide-react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { PathText } from "@/components/ui/path-text";
import { Progress } from "@/components/ui/progress";
import { Reference } from "@/components/ui/reference";
import { RevealButton } from "@/components/ui/reveal-button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { ago } from "@/features/tickets/ticket-source";
import { FieldError } from "@/components/ui/field";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  SYNC_MIN_POLL_SECS,
  syncApi,
  type SyncCounts,
  type SyncSettings as Settings,
  type SyncSettingsChange,
  type SyncSetupOptions,
  type SyncStatus,
} from "@/lib/sync-api";
import { syncReview } from "@/lib/sync-review-api";
import { attachments } from "@/lib/api/attachments";
import { useNow } from "@/lib/use-now";
import { SyncFailure as Failure } from "./SyncFailure";
import { useCommand } from "./use-sync-command";
import { storageName } from "./storage-name";
import { S3Place } from "./S3Place";
import { recoveryCopy } from "./sync-recovery";
import { useSyncStatus } from "./sync-status";
import "@/features/settings/settings.css";
import "./sync.css";

/** Where the Workspace's files are, as this page speaks of it. */
const placeOf = (provider: SyncStatus["provider"]) =>
  provider === "s3" ? "the bucket" : "Drive";

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

const contents = (counts: SyncCounts) =>
  [
    plural(counts.tickets, "ticket"),
    plural(counts.documents, "Document"),
    plural(counts.attachments, "Attachment"),
  ].join(", ");

function ConnectedAs({
  account,
  size,
}: {
  account: string | null;
  size?: "ui" | "caption";
}) {
  return (
    <StatusLabel tone="positive" {...(size ? { size } : {})}>
      {account ? `Connected as ${account}` : "Connected"}
    </StatusLabel>
  );
}

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
  return (
    <div className="settings-sync">
      <Track status={status} />
      {safetyBackup && <Replaced safetyBackup={plainPath(safetyBackup)} />}
      {!status && <StatusSkeleton />}
      {status &&
        (status.connection === "not_connected" ? (
          <Connect />
        ) : status.connection === "choosing" ? (
          <Choose
            status={status}
            onDownloaded={setSafetyBackup}
            onReplaced={onReplaced}
          />
        ) : // What stopped a first sync is shown with its action, not as progress standing still.
        status.first_sync && !status.recovery ? (
          <FirstSync status={status} progress={status.first_sync} />
        ) : (
          <Connected status={status} />
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
          A safety backup of the Workspace this desktop had before is kept.
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

function Connect() {
  const { busy, failure, run } = useCommand();
  // Whether this build has a Google Drive app configuration. Unknown until
  // read; only a plain "no" holds back the button.
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    void attachments
      .driveConfiguration()
      .then((config) => {
        if (current) setConfigured(config.configured);
      })
      .catch(() => {
        // Sign-in still reports why it cannot start.
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <>
      <div className="sync-block">
        <SettingsList>
          <SettingsRow
            leading={
              <SettingsRowTile>
                <Cloud size={20} />
              </SettingsRowTile>
            }
            title={
              <span role="status">
                {/* Waiting is not a state yet: words without a dot. */}
                {busy ? (
                  <span className="sync-waiting">
                    Waiting for sign-in in your browser…
                  </span>
                ) : (
                  <StatusLabel tone="neutral">Not connected</StatusLabel>
                )}
              </span>
            }
            description="Sign-in opens in your browser. ticketd only sees the files it creates."
            trailing={
              <Button
                size="sm"
                disabled={busy || configured === false}
                onClick={() =>
                  void run(syncApi.connect, "connect Google Drive")
                }
              >
                Connect Google Drive
                <ExternalLink aria-hidden="true" />
              </Button>
            }
          />
        </SettingsList>
        {configured === false && (
          <Alert role="status" className="mt-3">
            <AlertTitle>Google Drive isn't set up on this computer</AlertTitle>
            <AlertDescription>
              This build of ticketd has no Google Drive app configuration, so
              sign-in can't start. Install a build with Google Drive enabled.
              Your local files are unaffected.
            </AlertDescription>
          </Alert>
        )}
        <Failure>{failure}</Failure>
      </div>
      {/* The track above numbers the stages; these rows only explain them. */}
      <SettingsSection title="How sync works">
        <SettingsList>
          <SettingsRow
            title="Connect your Google account"
            description="You sign in with Google in your browser, then come back here."
          />
          <SettingsRow
            title="Choose a workspace"
            description="Upload this one to a new folder, or download one your other desktop already put in Drive."
          />
          <SettingsRow
            title="Keep working"
            description="Your own changes upload right after each save. Each desktop checks Drive for the others’ changes."
          />
        </SettingsList>
      </SettingsSection>
      <div className="sync-block">
        <Alert role="note">
          <AlertTitle>Files are not encrypted</AlertTitle>
          <AlertDescription>
            Each ticket and Document is saved in your Drive as a readable
            Markdown file. Anyone who can open that folder can read them.
          </AlertDescription>
        </Alert>
      </div>
    </>
  );
}

const UPLOAD = "upload";
const RECONNECT = "reconnect";

function Choose({
  status,
  onDownloaded,
  onReplaced,
}: {
  status: SyncStatus;
  /** Told where the safety backup of the replaced Workspace is. */
  onDownloaded: (safetyBackup: string) => void;
  onReplaced: () => Promise<void>;
}) {
  const now = useNow();
  const { busy, failure, run } = useCommand();
  const [options, setOptions] = useState<SyncSetupOptions | null>(null);
  const [readFailure, setReadFailure] = useState<FailureDescription | null>(
    null,
  );
  const provider = status.provider;
  // Read again when the person asks, once what the failure said is fixed.
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState(UPLOAD);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let current = true;
    syncApi
      .setupOptions()
      .then((read) => {
        if (!current) return;
        setOptions(read);
        // The folder this Workspace synced with is where it goes back to. Failing
        // that, nothing here to upload and a Workspace in Drive: that one is
        // what the person came for.
        const [first] = read.existing;
        if (read.reconnect) setChoice(RECONNECT);
        else if (
          first &&
          Object.values(read.local).every((count) => count === 0)
        )
          setChoice(first.folder_id);
      })
      .catch((reason: unknown) => {
        if (current)
          setReadFailure(describeFailure(reason, `read ${placeOf(provider)}`));
      });
    return () => {
      current = false;
    };
  }, [provider, attempt]);
  const download = options?.existing.find(
    (workspace) => workspace.folder_id === choice,
  );
  const account = status.account ?? "this account";
  const s3 = status.provider === "s3";
  const place = placeOf(status.provider);
  const storage = storageName(status.provider);
  return (
    <SettingsSection
      title="This Workspace"
      caption={<ConnectedAs account={status.account} size="caption" />}
    >
      {!options && !readFailure && (
        <p role="status" className="settings-hint">
          {s3
            ? "Checking the bucket and looking for Workspaces…"
            : "Looking for Workspaces in your Drive…"}
        </p>
      )}
      {options && (
        <ChoiceTiles
          aria-label="This Workspace"
          value={choice}
          disabled={busy}
          onValueChange={setChoice}
        >
          {options.reconnect && (
            <ChoiceTile
              value={RECONNECT}
              title={<>Reconnect to “{options.reconnect.name}”</>}
              description={`Changes made here and in ${place} are merged, and nothing is replaced`}
            />
          )}
          {/* Upload would land in the folder Reconnect names, minus the merge. */}
          {!options.reconnect && (
            <ChoiceTile
              value={UPLOAD}
              title="Upload this Workspace"
              description={`${plural(options.local.tickets, "ticket")} and ${plural(options.local.documents, "Document")} go to a new folder in ${s3 ? "the bucket" : "your Drive"}`}
            />
          )}
          {options.existing.map((workspace) => {
            const synced =
              workspace.last_synced_at && ago(workspace.last_synced_at, now);
            return (
              <ChoiceTile
                key={workspace.folder_id}
                value={workspace.folder_id}
                title={<>Download “{workspace.folder_name}”</>}
                description={`${plural(workspace.counts.tickets, "ticket")} and ${plural(workspace.counts.documents, "Document")}, ${
                  synced
                    ? `last synced ${workspace.last_synced_by ? `from ${workspace.last_synced_by} ` : ""}${synced}`
                    : "last sync not recorded"
                }`}
              />
            );
          })}
        </ChoiceTiles>
      )}
      <div className="sync-footer">
        <SettingsList>
          <SettingsListFooter
            actions={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setSwitching(true)}
                >
                  {s3 ? "Use another bucket…" : "Use another account…"}
                </Button>
                <Button
                  size="sm"
                  disabled={!options || busy}
                  onClick={() =>
                    download
                      ? setConfirming(true)
                      : void run(
                          choice === RECONNECT
                            ? syncApi.reconnect
                            : syncApi.uploadWorkspace,
                          "start sync",
                        )
                  }
                >
                  {download
                    ? "Download…"
                    : choice === RECONNECT
                      ? "Reconnect"
                      : "Start sync"}
                </Button>
              </>
            }
          >
            {s3
              ? "ticketd does not encrypt the files it puts in the bucket."
              : "Files in Drive are not encrypted."}
          </SettingsListFooter>
        </SettingsList>
      </div>
      {busy && (
        <p role="status" className="sync-status-line">
          Starting sync…
        </p>
      )}
      <Failure
        {...(readFailure && {
          onRetry: () => {
            setReadFailure(null);
            setAttempt((count) => count + 1);
          },
        })}
      >
        {readFailure ?? failure}
      </Failure>
      <DialogShell
        open={switching}
        onOpenChange={setSwitching}
        title={s3 ? "Use another bucket?" : "Use another Google account?"}
        description={
          s3
            ? "ticketd disconnects from this bucket so you can choose another bucket or profile. Nothing in the bucket or on this computer is deleted."
            : `ticketd disconnects from ${account} so you can sign in with a different Google account. Nothing in Drive or on this computer is deleted.`
        }
        primaryLabel={s3 ? "Use another bucket" : "Use another account"}
        blockedReason={null}
        size="sm"
        onSubmit={() => {
          setSwitching(false);
          void run(syncApi.disconnect, `disconnect from ${storage.full}`);
        }}
      >
        <dl className="sync-summary">
          <dt>On this computer</dt>
          <dd>This Workspace stays as it is</dd>
          <dt>{s3 ? "In the bucket" : "In Google Drive"}</dt>
          <dd>Your files stay, for your other desktops</dd>
        </dl>
      </DialogShell>
      {options && download && (
        // Replacing local data is destructive, reviewed like a restore: the
        // consequence first, then what changes, the safety net in the note
        // slot, and a primary named for the result (set BK-10).
        <DialogShell
          open={confirming}
          onOpenChange={setConfirming}
          title="Replace this Workspace?"
          description={`Downloads “${download.folder_name}” from ${place}.`}
          primaryLabel="Replace Workspace"
          primaryVariant="destructive"
          footerNote="A safety backup is saved first."
          blockedReason={null}
          size="md"
          onSubmit={() => {
            setConfirming(false);
            void run(async () => {
              const replaced = await syncApi.downloadWorkspace(
                download.folder_id,
              );
              onDownloaded(replaced.safety_backup);
              void onReplaced();
              return replaced;
            }, "replace this Workspace");
          }}
        >
          <Alert tone="attention" role="note">
            <AlertTitle>
              This replaces everything in this Workspace on this computer
            </AlertTitle>
            <AlertDescription>
              The Workspace from {place} takes its place. What is here now is
              kept only in the safety backup.
            </AlertDescription>
          </Alert>
          <dl className="sync-summary">
            <dt>From {place}</dt>
            <dd>{contents(download.counts)}</dd>
            <dt>Replaced here</dt>
            <dd>{contents(options.local)}</dd>
          </dl>
        </DialogShell>
      )}
    </SettingsSection>
  );
}

function FirstSync({
  status,
  progress,
}: {
  status: SyncStatus;
  progress: NonNullable<SyncStatus["first_sync"]>;
}) {
  const upload = progress.direction === "upload";
  const Icon = upload ? Upload : Download;
  return (
    <div className="sync-block">
      <SettingsList>
        <SettingsRow
          leading={
            <SettingsRowTile>
              <Icon />
            </SettingsRowTile>
          }
          title={
            <span role="status">
              {progress.total
                ? `${upload ? "Uploading" : "Downloading"} ${progress.done} of ${progress.total} files`
                : "Preparing…"}
            </span>
          }
          description={status.account}
          // The 64px bar beside the words that count it (set SR-09). Until
          // the files are counted there is no share to show.
          trailing={
            progress.total ? (
              <Progress
                aria-label={upload ? "First upload" : "First download"}
                value={progress.done}
                max={Math.max(progress.total, 1)}
              />
            ) : null
          }
        />
        <SettingsListFooter>
          {upload
            ? "You can keep working. Everything is already saved on this computer."
            : "A safety backup of the Workspace that was here is in Settings › Backups."}
        </SettingsListFooter>
      </SettingsList>
    </div>
  );
}

/** The attention notice for what stopped sync, with its one action. */
function RecoveryNotice({ status }: { status: SyncStatus }) {
  const { busy, failure, run } = useCommand();
  const copy = recoveryCopy(status);
  if (!copy) return null;
  return (
    <div className="sync-block">
      <Alert tone="attention">
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>{copy.description}</AlertDescription>
        <AlertActions>
          <Button
            size="sm"
            variant={
              status.recovery === "offline" ||
              status.recovery === "rate_limited"
                ? "outline"
                : "default"
            }
            disabled={busy}
            onClick={() =>
              void run(
                syncApi.recover,
                copy.action === "Retry" ? "sync" : copy.action.toLowerCase(),
              )
            }
          >
            {copy.action}
          </Button>
        </AlertActions>
      </Alert>
      <Failure>{failure}</Failure>
    </div>
  );
}

function Connected({ status }: { status: SyncStatus }) {
  const [openFailure, setOpenFailure] = useState<FailureDescription | null>(
    null,
  );
  const folder = status.folder?.name;
  if (status.provider === "s3")
    return (
      <>
        {status.recovery && <RecoveryNotice status={status} />}
        <S3Place status={status} />
        <DesktopSettings />
        <Disconnect status={status} />
      </>
    );
  return (
    <>
      {status.recovery && <RecoveryNotice status={status} />}
      <div className="sync-block">
        <SettingsList>
          <SettingsRow
            leading={
              <SettingsRowTile>
                <Cloud size={20} />
              </SettingsRowTile>
            }
            title={<ConnectedAs account={status.account} />}
            description={folder ? `“${folder}” in My Drive` : "Not created yet"}
            trailing={
              <Button
                variant="ghost"
                size="sm"
                disabled={!folder}
                onClick={() => {
                  setOpenFailure(null);
                  syncApi
                    .openFolder()
                    .catch((reason: unknown) =>
                      setOpenFailure(describeFailure(reason, "open Drive")),
                    );
                }}
              >
                Open in Drive
                <ExternalLink aria-hidden="true" />
              </Button>
            }
          />
          <SettingsListFooter>
            Files in Drive are not encrypted. ticketd only sees the files it
            creates there.
          </SettingsListFooter>
        </SettingsList>
        <Failure>{openFailure}</Failure>
      </div>
      <DesktopSettings />
      <Disconnect status={status} />
    </>
  );
}

function Disconnect({ status }: { status: SyncStatus }) {
  const folder = status.folder?.name;
  const s3 = status.provider === "s3";
  const { busy, failure, run } = useCommand();
  const [disconnecting, setDisconnecting] = useState(false);
  return (
    <SettingsSection title="Disconnect">
      <SettingsList>
        <SettingsRow
          title="Disconnect this desktop"
          description={`Stops syncing here. Your files stay ${s3 ? "in the bucket" : "in Drive"} and on this computer.`}
          trailing={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setDisconnecting(true)}
            >
              Disconnect…
            </Button>
          }
        />
      </SettingsList>
      <Failure>{failure}</Failure>
      <DialogShell
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title="Disconnect this desktop?"
        description="Sync stops on this desktop. Nothing is deleted."
        primaryLabel="Disconnect"
        blockedReason={null}
        size="sm"
        onSubmit={() => {
          setDisconnecting(false);
          void run(
            syncApi.disconnect,
            `disconnect from ${storageName(status.provider).full}`,
          );
        }}
      >
        <dl className="sync-summary">
          <dt>On this computer</dt>
          <dd>This Workspace stays as it is</dd>
          <dt>{s3 ? "In the bucket" : "In Google Drive"}</dt>
          <dd>
            {folder ? `“${folder}” stays` : "Your files stay"}, for your other
            desktops
          </dd>
        </dl>
      </DialogShell>
    </SettingsSection>
  );
}

/** A save-on-blur field's caption: being saved, just saved, or why not. */
type FieldNote =
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "not_saved" }
  | { kind: "invalid"; text: string }
  | null;

/**
 * The control and its one caption line under it, reserved so nothing moves:
 * "Saving…", "Saved" for two seconds, or the field's own error (set ST-32).
 */
function SavedField({
  id,
  note,
  children,
}: {
  id: string;
  note: FieldNote;
  children: React.ReactNode;
}) {
  return (
    <div className="sync-field">
      <div className="sync-field-control">{children}</div>
      {note?.kind === "invalid" ? (
        <FieldError id={`${id}-error`}>{note.text}</FieldError>
      ) : (
        <p className="sync-field-note" role="status">
          {note?.kind === "saving"
            ? "Saving…"
            : note?.kind === "not_saved"
              ? "Not saved"
              : note
                ? "Saved"
                : ""}
        </p>
      )}
    </div>
  );
}

/** This desktop's name, and the options: both save as soon as they change. */
function DesktopSettings() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  const [seconds, setSeconds] = useState("");
  // A command that failed: said under the section of the control that ran it.
  const [failure, setFailure] = useState<{
    failure: FailureDescription;
    section: "desktop" | "options";
    retry?: () => void;
  } | null>(null);
  const [notes, setNotes] = useState<{
    name: FieldNote;
    interval: FieldNote;
  }>({ name: null, interval: null });
  const note = (field: "name" | "interval", value: FieldNote) =>
    setNotes((current) => ({ ...current, [field]: value }));
  const fade = useRef<Partial<Record<"name" | "interval", number>>>({});
  useEffect(
    () => () => Object.values(fade.current).forEach(window.clearTimeout),
    [],
  );
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    syncApi
      .settings()
      .then((read) => {
        if (!current) return;
        setSaved(read);
        setName(read.desktop_name);
        setSeconds(String(read.poll_interval_secs));
      })
      .catch((reason: unknown) => {
        if (current)
          setFailure({
            failure: describeFailure(reason, "read the sync settings"),
            section: "desktop",
          });
      });
    return () => {
      current = false;
    };
  }, []);
  async function save(
    change: Partial<SyncSettingsChange>,
    field: "name" | "interval" | null,
  ) {
    if (!saved) return;
    setSaving(true);
    setFailure(null);
    if (field) {
      window.clearTimeout(fade.current[field]);
      note(field, { kind: "saving" });
    }
    try {
      const next = await syncApi.setSettings({
        desktop_name: saved.desktop_name,
        poll_interval_secs: saved.poll_interval_secs,
        attachment_download: saved.attachment_download,
        ...change,
      });
      setSaved(next);
      setName(next.desktop_name);
      setSeconds(String(next.poll_interval_secs));
      if (field) {
        note(field, { kind: "saved" });
        fade.current[field] = window.setTimeout(() => note(field, null), 2000);
      }
    } catch (reason) {
      if (field) note(field, { kind: "not_saved" });
      setFailure({
        failure: describeFailure(reason, "save the sync settings"),
        section: field === "name" ? "desktop" : "options",
        retry: () => void save(change, field),
      });
    } finally {
      setSaving(false);
    }
  }
  function saveName() {
    const next = name.trim();
    if (!saved || next === saved.desktop_name) {
      // The value in force is back: any refusal is over.
      if (notes.name?.kind === "invalid") note("name", null);
      return;
    }
    if (!next) {
      note("name", { kind: "invalid", text: "Enter a name for this desktop." });
      return;
    }
    void save({ desktop_name: next }, "name");
  }
  function saveInterval() {
    const next = Number(seconds);
    if (!saved || next === saved.poll_interval_secs) {
      if (notes.interval?.kind === "invalid") note("interval", null);
      return;
    }
    if (!Number.isInteger(next) || next < SYNC_MIN_POLL_SECS) {
      note("interval", {
        kind: "invalid",
        text: `Enter ${SYNC_MIN_POLL_SECS} seconds or more.`,
      });
      return;
    }
    void save({ poll_interval_secs: next }, "interval");
  }
  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };
  const disabled = !saved || saving;
  const invalid = (field: "name" | "interval") =>
    notes[field]?.kind === "invalid";
  return (
    <>
      <SettingsSection title="This desktop">
        <SettingsList>
          <SettingsRow
            variant="top"
            title={<Label htmlFor="sync-name">Name</Label>}
            description={
              <>
                Ticket code <Reference>{saved?.device_code}</Reference> · new
                tickets here are numbered T-{saved?.device_code}1, T-
                {saved?.device_code}2 and so on.
              </>
            }
            trailing={
              <SavedField id="sync-name" note={notes.name}>
                <Input
                  id="sync-name"
                  className="w-60"
                  value={name}
                  disabled={disabled}
                  aria-invalid={invalid("name") || undefined}
                  aria-describedby={
                    invalid("name") ? "sync-name-error" : undefined
                  }
                  onChange={(event) => {
                    setName(event.target.value);
                    setFailure(null);
                    note("name", null);
                  }}
                  onBlur={saveName}
                  onKeyDown={blurOnEnter}
                />
              </SavedField>
            }
          />
        </SettingsList>
        {failure?.section === "desktop" && (
          <Failure {...(failure.retry && { onRetry: failure.retry })}>
            {failure.failure}
          </Failure>
        )}
      </SettingsSection>
      <SettingsSection title="Options">
        <SettingsList>
          <SettingsRow
            variant="top"
            title={
              <Label htmlFor="sync-interval">Check for changes every</Label>
            }
            description={`Minimum ${SYNC_MIN_POLL_SECS} seconds. Your own changes upload right after each save.`}
            trailing={
              <SavedField id="sync-interval" note={notes.interval}>
                {/* Text with a numeric keyboard: no spinner inside the field. */}
                <Input
                  id="sync-interval"
                  className="w-24 text-right"
                  inputMode="numeric"
                  value={seconds}
                  disabled={disabled}
                  aria-invalid={invalid("interval") || undefined}
                  aria-describedby={
                    invalid("interval")
                      ? "sync-interval-unit sync-interval-error"
                      : "sync-interval-unit"
                  }
                  onChange={(event) => {
                    setSeconds(event.target.value);
                    setFailure(null);
                    note("interval", null);
                  }}
                  onBlur={saveInterval}
                  onKeyDown={blurOnEnter}
                />
                <span id="sync-interval-unit" className="sync-field-unit">
                  seconds
                </span>
              </SavedField>
            }
          />
          <SettingsRow
            variant="stacked"
            title="Attachments"
            titleId="sync-attachments-label"
          >
            <ChoiceTiles
              aria-labelledby="sync-attachments-label"
              value={saved?.attachment_download ?? ""}
              disabled={disabled}
              onValueChange={(value) =>
                void save(
                  {
                    attachment_download:
                      value as Settings["attachment_download"],
                  },
                  null,
                )
              }
            >
              <ChoiceTile
                value="automatic"
                title="Download automatically"
                description="Every file works offline"
              />
              <ChoiceTile
                value="on_open"
                title="Download when opened"
                description="Saves disk space"
              />
            </ChoiceTiles>
          </SettingsRow>
        </SettingsList>
        {failure?.section === "options" && (
          <Failure {...(failure.retry && { onRetry: failure.retry })}>
            {failure.failure}
          </Failure>
        )}
      </SettingsSection>
    </>
  );
}
