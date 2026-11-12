import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { ExternalLink } from "lucide-react";
import { RadioGroup } from "radix-ui";
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
import { Progress } from "@/components/ui/progress";
import { Reference } from "@/components/ui/reference";
import { StatusDot } from "@/components/ui/status-dot";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { ago } from "@/features/tickets/ticket-source";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  SYNC_MIN_POLL_SECS,
  syncApi,
  type SyncCounts,
  type SyncSettings as Settings,
  type SyncSettingsChange,
  type SyncSetupOptions,
  type SyncStatus,
} from "@/lib/sync-api";
import { useNow } from "@/lib/use-now";
import { recoveryCopy } from "./sync-recovery";
import { useSyncStatus } from "./sync-status";
import "@/features/settings/settings.css";
import "./sync.css";

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

const contents = (counts: SyncCounts) =>
  [
    plural(counts.tickets, "ticket"),
    plural(counts.documents, "Document"),
    plural(counts.attachments, "Attachment"),
  ].join(", ");

/** Runs one sync command at a time and keeps what it failed with. */
function useCommand() {
  const { apply } = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  async function run(command: () => Promise<SyncStatus>, failed: string) {
    setBusy(true);
    setFailure("");
    try {
      apply(await command());
      return true;
    } catch (reason) {
      setFailure(`${failed}: ${toFailure(reason).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, failure, run };
}

function Failure({ children }: { children: string }) {
  return children ? (
    <p role="alert" className="settings-failure">
      {children}
    </p>
  ) : null;
}

function ConnectedAs({ account }: { account: string | null }) {
  return (
    <p className="settings-label sync-account">
      <StatusDot tone="positive" size={10} />
      {account ? `Connected as ${account}` : "Connected"}
    </p>
  );
}

/** Settings › Sync: setup until this Workspace syncs, then its settings. */
export function SyncSettings({
  heading,
}: {
  heading?: RefObject<HTMLHeadingElement | null>;
}) {
  const { status } = useSyncStatus();
  // Where the Workspace a download replaced was kept, while this page is open.
  const [safetyBackup, setSafetyBackup] = useState("");
  return (
    <div className="settings-column source-settings-column">
      <h1 id="settings-heading" ref={heading} tabIndex={-1}>
        Sync
      </h1>
      <p>
        Keeps this Workspace the same on your desktops, through your own Google
        Drive.
      </p>
      {safetyBackup && (
        <Alert role="status">
          <AlertTitle>This Workspace was replaced</AlertTitle>
          <AlertDescription>
            A safety backup of the Workspace this desktop had before is kept at{" "}
            <code aria-label="Safety backup path">{safetyBackup}</code>
          </AlertDescription>
        </Alert>
      )}
      {status &&
        (status.connection === "not_connected" ? (
          <Connect />
        ) : status.connection === "choosing" ? (
          <Choose status={status} onDownloaded={setSafetyBackup} />
        ) : status.first_sync ? (
          <FirstSync status={status} progress={status.first_sync} />
        ) : (
          <Connected status={status} />
        ))}
    </div>
  );
}

function Connect() {
  const { busy, failure, run } = useCommand();
  return (
    <SettingsCard
      id="sync"
      title="Google Drive"
      footer={
        <p className="settings-hint">
          Sign-in opens in your browser. ticketd only sees the files it creates.
        </p>
      }
    >
      <Alert role="note">
        <AlertTitle>Files are not encrypted</AlertTitle>
        <AlertDescription>
          Each ticket and Document is saved in your Drive as a readable Markdown
          file. Anyone who can open that folder can read them.
        </AlertDescription>
      </Alert>
      <div className="sync-inline">
        <Button
          disabled={busy}
          onClick={() =>
            void run(syncApi.connect, "Could not connect Google Drive")
          }
        >
          Connect Google Drive
          <ExternalLink aria-hidden="true" />
        </Button>
        {busy && (
          <span role="status">Waiting for sign-in in your browser…</span>
        )}
      </div>
      <Failure>{failure}</Failure>
    </SettingsCard>
  );
}

const UPLOAD = "upload";

function Choose({
  status,
  onDownloaded,
}: {
  status: SyncStatus;
  /** Told where the safety backup of the replaced Workspace is. */
  onDownloaded: (safetyBackup: string) => void;
}) {
  const now = useNow();
  const { busy, failure, run } = useCommand();
  const [options, setOptions] = useState<SyncSetupOptions | null>(null);
  const [readFailure, setReadFailure] = useState("");
  const [choice, setChoice] = useState(UPLOAD);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    let current = true;
    syncApi
      .setupOptions()
      .then((read) => {
        if (current) setOptions(read);
      })
      .catch((reason: unknown) => {
        if (current)
          setReadFailure(
            `Could not read your Drive: ${toFailure(reason).message}`,
          );
      });
    return () => {
      current = false;
    };
  }, []);
  const download = options?.existing.find(
    (workspace) => workspace.folder_id === choice,
  );
  return (
    <SettingsCard
      id="sync"
      title="Google Drive"
      footer={
        <>
          <p className="settings-hint">Files in Drive are not encrypted.</p>
          <div className="settings-actions">
            <Button
              disabled={!options || busy}
              onClick={() =>
                download
                  ? setConfirming(true)
                  : void run(syncApi.uploadWorkspace, "Sync did not start")
              }
            >
              {download ? "Download…" : "Start sync"}
            </Button>
          </div>
        </>
      }
    >
      <ConnectedAs account={status.account} />
      {options && (
        <div className="settings-row settings-row-stacked">
          <div>
            <p id="sync-choice-label" className="settings-label">
              This Workspace
            </p>
          </div>
          <RadioGroup.Root
            aria-labelledby="sync-choice-label"
            value={choice}
            disabled={busy}
            onValueChange={setChoice}
            className="upload-destination-choices"
          >
            <RadioGroup.Item
              value={UPLOAD}
              className="upload-destination-choice"
            >
              <span className="layout-choice-dot" aria-hidden="true" />
              <span>
                Upload this Workspace
                <small>
                  {plural(options.local.tickets, "ticket")} and{" "}
                  {plural(options.local.documents, "Document")} go to a new
                  folder in your Drive
                </small>
              </span>
            </RadioGroup.Item>
            {options.existing.map((workspace) => {
              const synced =
                workspace.last_synced_at && ago(workspace.last_synced_at, now);
              return (
                <RadioGroup.Item
                  key={workspace.folder_id}
                  value={workspace.folder_id}
                  className="upload-destination-choice"
                >
                  <span className="layout-choice-dot" aria-hidden="true" />
                  <span>
                    Download an existing Workspace
                    <small>
                      “{workspace.folder_name}”
                      {synced &&
                        `, last synced ${workspace.last_synced_by ? `from ${workspace.last_synced_by} ` : ""}${synced}`}
                    </small>
                  </span>
                </RadioGroup.Item>
              );
            })}
          </RadioGroup.Root>
        </div>
      )}
      {busy && <p role="status">Starting sync…</p>}
      <Failure>{readFailure || failure}</Failure>
      {options && download && (
        <DialogShell
          open={confirming}
          onOpenChange={setConfirming}
          title="Replace this Workspace?"
          description="The Workspace from Drive replaces the one on this desktop. A safety backup is saved first."
          primaryLabel="Download and replace"
          blockedReason={null}
          width={573}
          onSubmit={() => {
            setConfirming(false);
            void run(async () => {
              const replaced = await syncApi.downloadWorkspace(
                download.folder_id,
              );
              onDownloaded(replaced.safety_backup);
              return replaced;
            }, "This Workspace was not replaced");
          }}
        >
          <dl className="sync-summary">
            <dt>From Drive</dt>
            <dd>{contents(download.counts)}</dd>
            <dt>Replaced here</dt>
            <dd>{contents(options.local)}</dd>
          </dl>
        </DialogShell>
      )}
    </SettingsCard>
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
  return (
    <SettingsCard
      id="sync"
      title="Google Drive"
      footer={
        <p className="settings-hint">
          {upload
            ? "You can keep working. Everything is already saved on this computer."
            : "A safety backup of the Workspace that was here is in Settings › Backups."}
        </p>
      }
    >
      <ConnectedAs account={status.account} />
      <div className="sync-progress-row" role="status">
        <Progress
          aria-label={upload ? "First upload" : "First download"}
          value={progress.done}
          max={Math.max(progress.total, 1)}
        />
        <span>
          {upload ? "Uploading" : "Downloading"} {progress.done} of{" "}
          {progress.total} files
        </span>
      </div>
    </SettingsCard>
  );
}

/** The attention notice for what stopped sync, with its one action. */
function RecoveryNotice({ status }: { status: SyncStatus }) {
  const { busy, failure, run } = useCommand();
  const copy = recoveryCopy(status);
  if (!copy) return null;
  return (
    <>
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
              void run(syncApi.recover, `${copy.action} did not work`)
            }
          >
            {copy.action}
          </Button>
        </AlertActions>
      </Alert>
      <Failure>{failure}</Failure>
    </>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div>
        <p className="settings-label">{label}</p>
        <p className="settings-hint">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Connected({ status }: { status: SyncStatus }) {
  const { busy, failure, run } = useCommand();
  const [disconnecting, setDisconnecting] = useState(false);
  const [openFailure, setOpenFailure] = useState("");
  const folder = status.folder?.name;
  return (
    <>
      <SettingsCard
        id="sync"
        title="Google Drive"
        footer={
          <p className="settings-hint">
            Files in Drive are not encrypted. ticketd only sees the files it
            creates there.
          </p>
        }
      >
        {status.recovery ? (
          <RecoveryNotice status={status} />
        ) : (
          <ConnectedAs account={status.account} />
        )}
        <Row
          label="Folder"
          hint={folder ? `“${folder}” in My Drive` : "Not created yet"}
        >
          <Button
            variant="ghost"
            disabled={!folder}
            onClick={() => {
              setOpenFailure("");
              syncApi
                .openFolder()
                .catch((reason: unknown) =>
                  setOpenFailure(
                    `Could not open Drive: ${toFailure(reason).message}`,
                  ),
                );
            }}
          >
            Open in Drive
            <ExternalLink aria-hidden="true" />
          </Button>
        </Row>
        <Row
          label="Disconnect this desktop"
          hint="Stops syncing here. Your files stay in Drive and on this computer."
        >
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setDisconnecting(true)}
          >
            Disconnect…
          </Button>
        </Row>
        <Failure>{openFailure || failure}</Failure>
        <DialogShell
          open={disconnecting}
          onOpenChange={setDisconnecting}
          title="Disconnect this desktop?"
          description="Sync stops on this desktop. Nothing is deleted."
          primaryLabel="Disconnect"
          blockedReason={null}
          width={480}
          onSubmit={() => {
            setDisconnecting(false);
            void run(syncApi.disconnect, "Still connected");
          }}
        >
          <dl className="sync-summary">
            <dt>On this computer</dt>
            <dd>This Workspace stays as it is</dd>
            <dt>In Google Drive</dt>
            <dd>
              {folder ? `“${folder}” stays` : "Your files stay"}, for your other
              desktops
            </dd>
          </dl>
        </DialogShell>
      </SettingsCard>
      <DesktopSettings />
    </>
  );
}

/** This desktop's name, and the options: both save as soon as they change. */
function DesktopSettings() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  const [seconds, setSeconds] = useState("");
  const [failure, setFailureText] = useState("");
  // The message belongs to the card whose control caused it.
  const [failedName, setFailedName] = useState(false);
  const setFailure = (text: string, name = false) => {
    setFailureText(text);
    setFailedName(name);
  };
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
          setFailure(
            `Could not read the sync settings: ${toFailure(reason).message}`,
          );
      });
    return () => {
      current = false;
    };
  }, []);
  async function save(change: Partial<SyncSettingsChange>) {
    if (!saved) return;
    setSaving(true);
    setFailure("");
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
    } catch (reason) {
      setFailure(
        `Could not save the sync settings: ${toFailure(reason).message}`,
      );
    } finally {
      setSaving(false);
    }
  }
  function saveName() {
    const next = name.trim();
    if (!saved || next === saved.desktop_name) return;
    if (!next) {
      setFailure("Enter a name for this desktop.", true);
      return;
    }
    void save({ desktop_name: next });
  }
  function saveInterval() {
    const next = Number(seconds);
    if (!saved || next === saved.poll_interval_secs) return;
    if (!Number.isInteger(next) || next < SYNC_MIN_POLL_SECS) {
      setFailure(`Enter ${SYNC_MIN_POLL_SECS} seconds or more.`);
      return;
    }
    void save({ poll_interval_secs: next });
  }
  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };
  const disabled = !saved || saving;
  return (
    <>
      <SettingsCard id="sync-desktop" title="This desktop">
        <div className="settings-row">
          <div>
            <Label htmlFor="sync-name">Name</Label>
            <p className="settings-hint">
              Ticket code <Reference>{saved?.device_code}</Reference> · new
              tickets here are numbered T-{saved?.device_code}1, T-
              {saved?.device_code}2 and so on.
            </p>
          </div>
          <Input
            id="sync-name"
            className="w-60"
            value={name}
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={blurOnEnter}
          />
        </div>
        <Failure>{failedName ? failure : ""}</Failure>
      </SettingsCard>
      <SettingsCard id="sync-options" title="Options">
        <div className="settings-row">
          <div>
            <Label htmlFor="sync-interval">Check for changes every</Label>
            <p className="settings-hint">
              Minimum {SYNC_MIN_POLL_SECS} seconds. Your own changes upload
              right after each save.
            </p>
          </div>
          <span className="sync-interval">
            <Input
              id="sync-interval"
              type="number"
              min={SYNC_MIN_POLL_SECS}
              step={1}
              value={seconds}
              disabled={disabled}
              aria-describedby="sync-interval-unit"
              onChange={(event) => setSeconds(event.target.value)}
              onBlur={saveInterval}
              onKeyDown={blurOnEnter}
            />
            <span id="sync-interval-unit" className="settings-hint">
              seconds
            </span>
          </span>
        </div>
        <div className="settings-row settings-row-stacked">
          <div>
            <p id="sync-attachments-label" className="settings-label">
              Attachments
            </p>
          </div>
          <RadioGroup.Root
            aria-labelledby="sync-attachments-label"
            value={saved?.attachment_download ?? ""}
            disabled={disabled}
            onValueChange={(value) =>
              void save({
                attachment_download: value as Settings["attachment_download"],
              })
            }
            className="upload-destination-choices"
          >
            <RadioGroup.Item
              value="automatic"
              className="upload-destination-choice"
            >
              <span className="layout-choice-dot" aria-hidden="true" />
              <span>
                Download automatically<small>Every file works offline</small>
              </span>
            </RadioGroup.Item>
            <RadioGroup.Item
              value="on_open"
              className="upload-destination-choice"
            >
              <span className="layout-choice-dot" aria-hidden="true" />
              <span>
                Download when opened<small>Saves disk space</small>
              </span>
            </RadioGroup.Item>
          </RadioGroup.Root>
        </div>
        {saving && <p role="status">Saving…</p>}
        <Failure>{failedName ? "" : failure}</Failure>
      </SettingsCard>
    </>
  );
}
