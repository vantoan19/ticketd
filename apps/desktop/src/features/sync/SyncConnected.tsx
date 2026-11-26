import { useEffect, useRef, useState } from "react";
import { Cloud, Cylinder, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import { useCopy } from "@/components/ui/use-copy";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { s3Api, type S3FolderLinks } from "@/lib/s3-api";
import {
  SYNC_MIN_POLL_SECS,
  syncApi,
  type SyncDevice,
  type SyncSettings as Settings,
  type SyncSettingsChange,
  type SyncStatus,
} from "@/lib/sync-api";
import { useNow } from "@/lib/use-now";
import { SyncFailure as Failure } from "./SyncFailure";
import { storageName } from "./storage-name";
import { recoveryCopy, statusRow } from "./sync-recovery";
import { useSyncStatus } from "./sync-status";
import { agoWords, placeOf } from "./sync-words";
import { useCommand } from "./use-sync-command";
import "@/features/settings/settings.css";
import "./sync.css";

/**
 * Settings › Workspace sync once this Workspace syncs: the status row (with its one fix
 * when sync stopped), the computers that share it, the options, and a last row that
 * stops syncing on this computer.
 */
export function SyncConnected({ status }: { status: SyncStatus }) {
  // This computer's name and the options, read once and kept here: Rename… and the
  // Options both write them.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  useEffect(() => {
    let current = true;
    syncApi
      .settings()
      .then((read) => {
        if (current) setSettings(read);
      })
      .catch((reason: unknown) => {
        if (current)
          setFailure(describeFailure(reason, "read the sync settings"));
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <>
      <StatusRow status={status} />
      <Computers
        settings={settings}
        syncedAt={status.last_synced_at}
        onRenamed={setSettings}
      />
      <Options settings={settings} onSaved={setSettings} />
      {failure && (
        <FailureAlert size="compact" failure={failure} className="mt-3" />
      )}
      <StopSyncing status={status} />
    </>
  );
}

/** The one place a person looks for "is it working", and the fix when it is not. */
function StatusRow({ status }: { status: SyncStatus }) {
  const now = useNow();
  const { openReview } = useSyncStatus();
  const { busy, failure, run } = useCommand();
  const [disconnecting, setDisconnecting] = useState(false);
  const row = statusRow(status, now);
  const copy = recoveryCopy(status);
  const s3 = status.provider === "s3";
  // Retrying cannot help until the profile is changed back, so the way out the message
  // names comes first, and Retry is for a person who did that.
  const moved = status.recovery === "service_changed";
  const noCli = status.recovery === "cli_unavailable";
  const reviewing = status.state === "needs_attention" && !status.recovery;
  const signIn = status.recovery === "authorization_expired";
  // A picked program is remembered for this computer, so sync tries again at once.
  const chooseProgram = async () => {
    const picked = await s3Api.chooseCli();
    if (!picked) return syncApi.status();
    return syncApi.recover();
  };
  const retry = (variant: "default" | "outline") => (
    <Button
      size="sm"
      variant={variant}
      disabled={busy}
      onClick={() => void run(syncApi.recover, "sync")}
    >
      Retry
    </Button>
  );
  const fix = reviewing ? (
    <Button size="sm" onClick={openReview}>
      Review
    </Button>
  ) : !copy ? null : moved ? (
    <>
      {retry("outline")}
      <Button size="sm" disabled={busy} onClick={() => setDisconnecting(true)}>
        Disconnect…
      </Button>
    </>
  ) : noCli ? (
    <>
      {retry("outline")}
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void run(chooseProgram, "use that program")}
      >
        {copy.action}
      </Button>
    </>
  ) : (
    <Button
      size="sm"
      variant={
        status.recovery === "offline" || status.recovery === "rate_limited"
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
      {busy && copy.working ? copy.working : copy.action}
      {signIn && <ExternalLink aria-hidden="true" />}
    </Button>
  );
  return (
    <div className="sync-block">
      <SettingsList
        role={status.recovery ? "alert" : "group"}
        aria-label="Sync status"
      >
        <SettingsRow
          leading={
            <SettingsRowTile>
              {s3 ? <Cylinder size={20} /> : <Cloud size={20} />}
            </SettingsRowTile>
          }
          title={<StatusLabel tone={row.tone}>{row.label}</StatusLabel>}
          description={<span className="wrap-anywhere">{row.description}</span>}
          trailing={fix}
        />
        <Place status={status} />
      </SettingsList>
      <Failure>{failure}</Failure>
      {moved && (
        <DisconnectDialog
          status={status}
          open={disconnecting}
          onOpenChange={setDisconnecting}
          onConfirm={() => {
            setDisconnecting(false);
            void run(
              syncApi.disconnect,
              `disconnect from ${storageName(status.provider).full}`,
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * Where the Workspace lives, as the footer of the status row: the folder in Drive or the
 * `s3://` address, that its files are not encrypted, and one way to look at them (Drive,
 * the AWS console where the bucket is on AWS, otherwise the address to copy).
 */
function Place({ status }: { status: SyncStatus }) {
  const [links, setLinks] = useState<S3FolderLinks | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const { copied, error, copy } = useCopy();
  const s3 = status.s3;
  const folder = status.folder?.name;
  const hasFolder = status.folder !== null;
  useEffect(() => {
    if (!s3 || !hasFolder) return;
    let current = true;
    s3Api
      .folderLinks()
      .then((read) => {
        if (current) setLinks(read);
      })
      .catch(() => {
        // The address is still in the footer; only the shortcut is missing.
      });
    return () => {
      current = false;
    };
    // The folder and bucket do not change while connected.
  }, [s3, hasFolder]);
  const open = (opening: string) => {
    setFailure(null);
    syncApi
      .openFolder()
      .catch((reason: unknown) => setFailure(describeFailure(reason, opening)));
  };
  let action = null;
  if (!s3) {
    action = (
      <SettingsLink disabled={!hasFolder} onClick={() => open("open Drive")}>
        Open in Drive
      </SettingsLink>
    );
  } else if (links?.console) {
    action = (
      <SettingsLink onClick={() => open("open the AWS console")}>
        Open in AWS console
      </SettingsLink>
    );
  } else if (links) {
    action = (
      <SettingsLink onClick={() => void copy("address", links.address)}>
        {copied ? "Copied" : "Copy s3:// address"}
      </SettingsLink>
    );
  }
  return (
    <>
      <SettingsListFooter actions={action}>
        {s3
          ? `s3://${s3.bucket}/${s3.prefix} · readable files, not encrypted by ticketd.`
          : folder
            ? `“${folder}” in your Google Drive. Readable files, not encrypted.`
            : "Not created yet. Readable files, not encrypted."}
      </SettingsListFooter>
      {error && <p className="settings-hint">{error}</p>}
      <Failure>{failure}</Failure>
    </>
  );
}

/** "tickets T-KQ1, T-KQ2…": what the code makes of this computer's next tickets. */
const codes = (code: string) => `tickets T-${code}1, T-${code}2…`;

/** The computers that share this Workspace, from the device list. */
function Computers({
  settings,
  syncedAt,
  onRenamed,
}: {
  settings: Settings | null;
  /** Changes with each sync run, which may have brought another computer's news. */
  syncedAt: string | null;
  onRenamed: (settings: Settings) => void;
}) {
  const now = useNow();
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [unread, setUnread] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const name = settings?.desktop_name;
  useEffect(() => {
    let current = true;
    syncApi
      .devices()
      .then((read) => {
        if (!current) return;
        setUnread(false);
        setDevices(read);
      })
      .catch(() => {
        // The list is a courtesy: this computer still shows, from its settings.
        if (current) setUnread(true);
      });
    return () => {
      current = false;
    };
    // After a run (others' news) and after a rename (the name in force).
  }, [syncedAt, name]);
  const list: SyncDevice[] | null =
    devices && devices.length > 0 && !unread
      ? devices
      : settings
        ? [
            {
              id: "this",
              name: settings.desktop_name,
              code: settings.device_code,
              last_synced_at: null,
              this: true,
            },
          ]
        : null;
  return (
    <SettingsSection title="Computers">
      <SettingsList>
        {list === null ? (
          <SettingsRow
            title={<Skeleton className="h-5 w-32" />}
            description={<Skeleton className="mt-1 h-4 w-56 max-w-full" />}
          />
        ) : (
          list.map((device) => (
            <SettingsRow
              key={device.id}
              title={device.this && name ? name : device.name}
              description={
                device.this
                  ? `This computer · ${codes(device.code)}`
                  : `${
                      device.last_synced_at
                        ? `Last change ${agoWords(device.last_synced_at, now) ?? device.last_synced_at}`
                        : "No changes yet"
                    } · ${codes(device.code)}`
              }
              trailing={
                device.this ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!settings}
                    onClick={() => setRenaming(true)}
                  >
                    Rename…
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </SettingsList>
      {renaming && settings && (
        <RenameDialog
          settings={settings}
          onClose={() => setRenaming(false)}
          onRenamed={(next) => {
            setRenaming(false);
            onRenamed(next);
          }}
        />
      )}
    </SettingsSection>
  );
}

/** Names this computer; the other computers read the new name from the device list. Mounted while it is open. */
function RenameDialog({
  settings,
  onClose,
  onRenamed,
}: {
  settings: Settings;
  onClose: () => void;
  onRenamed: (settings: Settings) => void;
}) {
  const [name, setName] = useState(settings.desktop_name);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const next = name.trim();
  const blocked = !next
    ? "Enter a name for this computer."
    : next.length > 100
      ? "Use a shorter name."
      : null;
  async function rename() {
    if (next === settings.desktop_name) {
      onClose();
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      onRenamed(
        await syncApi.setSettings({
          desktop_name: next,
          poll_interval_secs: settings.poll_interval_secs,
          attachment_download: settings.attachment_download,
        }),
      );
    } catch (reason) {
      setFailure(describeFailure(reason, "rename this computer"));
      setSaving(false);
    }
  }
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      size="sm"
      title="Rename this computer"
      description="Your other computers list it by this name."
      primaryLabel="Rename"
      blockedReason={blocked}
      busy={saving}
      error={failure && <FailureAlert size="compact" failure={failure} />}
      onSubmit={() => void rename()}
    >
      <Label htmlFor="sync-computer-name">Name</Label>
      <Input
        id="sync-computer-name"
        className="mt-2"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setFailure(null);
        }}
      />
    </DialogShell>
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

/** How often to look for changes, and whether files from other computers download at once. Both save as soon as they change. */
function Options({
  settings: saved,
  onSaved,
}: {
  settings: Settings | null;
  onSaved: (settings: Settings) => void;
}) {
  // What is typed, until it is saved or given up; otherwise the value in force.
  const [draft, setDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    failure: FailureDescription;
    retry?: () => void;
  } | null>(null);
  const [note, setNote] = useState<FieldNote>(null);
  const fade = useRef<number | undefined>(undefined);
  const check = useCommand();
  useEffect(() => () => window.clearTimeout(fade.current), []);
  const [saving, setSaving] = useState(false);
  const seconds = draft ?? String(saved?.poll_interval_secs ?? "");
  async function save(
    change: Partial<SyncSettingsChange>,
    field: "interval" | null,
  ) {
    if (!saved) return;
    setSaving(true);
    setFailure(null);
    if (field) {
      window.clearTimeout(fade.current);
      setNote({ kind: "saving" });
    }
    try {
      const next = await syncApi.setSettings({
        desktop_name: saved.desktop_name,
        poll_interval_secs: saved.poll_interval_secs,
        attachment_download: saved.attachment_download,
        ...change,
      });
      onSaved(next);
      setDraft(null);
      if (field) {
        setNote({ kind: "saved" });
        fade.current = window.setTimeout(() => setNote(null), 2000);
      }
    } catch (reason) {
      if (field) setNote({ kind: "not_saved" });
      setFailure({
        failure: describeFailure(reason, "save the sync settings"),
        retry: () => void save(change, field),
      });
    } finally {
      setSaving(false);
    }
  }
  function saveInterval() {
    const next = Number(seconds);
    if (!saved || next === saved.poll_interval_secs) {
      // The value in force is back: any refusal is over.
      setDraft(null);
      if (note?.kind === "invalid") setNote(null);
      return;
    }
    if (!Number.isInteger(next) || next < SYNC_MIN_POLL_SECS) {
      setNote({
        kind: "invalid",
        text: `Enter ${SYNC_MIN_POLL_SECS} seconds or more.`,
      });
      return;
    }
    void save({ poll_interval_secs: next }, "interval");
  }
  const disabled = !saved || saving;
  const invalid = note?.kind === "invalid";
  return (
    <SettingsSection title="Options">
      <SettingsList>
        <SettingsRow
          variant="top"
          title={<Label htmlFor="sync-interval">Check for changes every</Label>}
          description={`At least ${SYNC_MIN_POLL_SECS} seconds. Your own changes upload right after each save.`}
          trailing={
            <SavedField id="sync-interval" note={note}>
              {/* Text with a numeric keyboard: no spinner inside the field. */}
              <Input
                id="sync-interval"
                className="w-24 text-right"
                inputMode="numeric"
                value={seconds}
                disabled={disabled}
                aria-invalid={invalid || undefined}
                aria-describedby={
                  invalid
                    ? "sync-interval-unit sync-interval-error"
                    : "sync-interval-unit"
                }
                onChange={(event) => {
                  setDraft(event.target.value);
                  setFailure(null);
                  setNote(null);
                }}
                onBlur={saveInterval}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span id="sync-interval-unit" className="sync-field-unit">
                seconds
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={check.busy}
                onClick={() =>
                  void check.run(syncApi.syncNow, "check for changes")
                }
              >
                <RefreshCw aria-hidden="true" />
                {check.busy ? "Checking…" : "Check now"}
              </Button>
            </SavedField>
          }
        />
        <SettingsRow
          variant="stacked"
          title="Files from your other computers"
          titleId="sync-attachments-label"
        >
          <ChoiceTiles
            aria-labelledby="sync-attachments-label"
            className="mt-2.5"
            value={saved?.attachment_download ?? ""}
            disabled={disabled}
            onValueChange={(value) =>
              void save(
                {
                  attachment_download: value as Settings["attachment_download"],
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
      <Failure>{check.failure}</Failure>
      {failure && (
        <Failure {...(failure.retry && { onRetry: failure.retry })}>
          {failure.failure}
        </Failure>
      )}
    </SettingsSection>
  );
}

/** The last row of the page: stop syncing here, which deletes nothing. */
function StopSyncing({ status }: { status: SyncStatus }) {
  const { busy, failure, run } = useCommand();
  const [disconnecting, setDisconnecting] = useState(false);
  return (
    <div className="settings-section">
      <SettingsList>
        <SettingsRow
          title="Stop syncing on this computer"
          description={`Your files stay in ${placeOf(status.provider)} and on this computer.`}
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
      <DisconnectDialog
        status={status}
        open={disconnecting}
        onOpenChange={setDisconnecting}
        onConfirm={() => {
          setDisconnecting(false);
          void run(
            syncApi.disconnect,
            `disconnect from ${storageName(status.provider).full}`,
          );
        }}
      />
    </div>
  );
}

/** The confirmation of Disconnect, where the page offers it. */
function DisconnectDialog({
  status,
  open,
  onOpenChange,
  onConfirm,
}: {
  status: SyncStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const folder = status.folder?.name;
  const s3 = status.provider === "s3";
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Disconnect this computer?"
      description="Sync stops on this computer. Nothing is deleted."
      primaryLabel="Disconnect"
      blockedReason={null}
      size="sm"
      onSubmit={onConfirm}
    >
      <dl className="sync-summary">
        <dt>On this computer</dt>
        <dd>This Workspace stays as it is</dd>
        <dt>{s3 ? "In the bucket" : "In Google Drive"}</dt>
        <dd>
          {folder ? `“${folder}” stays` : "Your files stay"}, for your other
          computers
        </dd>
      </dl>
    </DialogShell>
  );
}
