import { useEffect, useRef, useState } from "react";
import { Cloud, ExternalLink, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { FailureAlert } from "@/components/ui/failure-alert";
import { StatusLabel } from "@/components/ui/status-label";
import {
  attachments,
  type AttachmentUploadDestination,
  type DriveConfiguration,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { syncApi } from "@/lib/sync-api";
import { useSyncStatus } from "@/features/sync/sync-status";
import {
  UseAnotherAccountDialog,
  type SyncWithAccount,
} from "@/features/sync/UseAnotherAccountDialog";
import { SettingsSection } from "./layout/SettingsSection";
import { SettingsList, SettingsRow } from "./layout/SettingsList";
import "./pages/attachments.css";

/** The Files page's content: where new files go, and the Google account they use. */
export function AttachmentSettings() {
  const { status, apply } = useSyncStatus();
  const [destination, setDestination] =
    useState<AttachmentUploadDestination | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  // Unknown (null) until Drive's configuration is read; only a definite "no"
  // disables the Drive tile.
  const [configuration, setConfiguration] = useState<DriveConfiguration | null>(
    null,
  );
  const configured = configuration ? configuration.configured : null;
  const selection = useRef<string | null>(null);
  const active = useRef(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    active.current = true;
    let current = true;
    void attachments
      .uploadDestination()
      .then((saved) => {
        if (current) {
          setDestination(saved);
          setFailure(null);
        }
      })
      .catch((reason: unknown) => {
        if (current)
          setFailure(describeFailure(reason, "read the upload destination"));
      });
    return () => {
      current = false;
      active.current = false;
      if (selection.current)
        void attachments
          .cancelDriveSelection(selection.current)
          .catch(() => {});
    };
  }, [reload]);
  useEffect(() => {
    let current = true;
    void attachments
      .driveConfiguration()
      .then((config) => {
        if (current) setConfiguration(config);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  // Workspace sync on Google Drive: the Workspace's folder, and the one Google sign-in.
  const drive = status?.provider === "google_drive" ? status : null;
  const syncFolder = drive?.connection === "connected" ? drive.folder : null;
  const syncFolderId = syncFolder?.id;
  const signedIn = !!drive?.connection_id;
  const signedOut = !!syncFolder && drive?.recovery === "authorization_expired";
  const sync: SyncWithAccount = syncFolder
    ? "syncing"
    : signedIn
      ? "choosing"
      : "off";
  const onDriveDestination =
    destination?.kind === "google_drive" ? destination : null;
  const inSyncFolder =
    !!syncFolderId && onDriveDestination?.sync_folder === syncFolderId;
  const account = signedIn
    ? (drive?.account ?? null)
    : (onDriveDestination?.account ?? null);

  // A Drive folder chosen before sync was set up gives way to the Uploads folder inside the
  // sync folder: there is one place in Drive for one Workspace.
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!syncFolderId || !onDriveDestination || inSyncFolder) return;
    if (followed.current === syncFolderId) return;
    followed.current = syncFolderId;
    attachments
      .useSyncUploadsFolder()
      .then((saved) => {
        if (active.current) setDestination(saved);
      })
      .catch((reason: unknown) => {
        if (active.current)
          setFailure(describeFailure(reason, "use the Uploads folder"));
      });
  }, [syncFolderId, onDriveDestination, inSyncFolder]);

  async function choose(kind: string) {
    setFailure(null);
    setBusy(true);
    try {
      let saved: AttachmentUploadDestination;
      if (kind !== "google_drive") {
        saved = await attachments.setUploadDestination(null);
      } else if (syncFolder) {
        // Sync's own sign-in and its folder: nothing to choose, nothing to ask.
        saved = await attachments.useSyncUploadsFolder();
      } else {
        const config = await attachments.driveConfiguration();
        if (!active.current) return;
        setConfiguration(config);
        if (!config.configured) return;
        const operation = crypto.randomUUID();
        selection.current = operation;
        const picked = await attachments.chooseDriveFolder(operation);
        if (!active.current) return;
        saved = await attachments.setUploadDestination(
          picked.destination,
          picked.account ?? null,
        );
      }
      if (active.current) setDestination(saved);
    } catch (reason) {
      if (active.current)
        setFailure(describeFailure(reason, "change the upload destination"));
    } finally {
      selection.current = null;
      if (active.current) setBusy(false);
    }
  }

  /** One sign-in again for Files and Workspace sync: both resume. */
  async function signInAgain() {
    setFailure(null);
    setBusy(true);
    try {
      apply(await syncApi.recover());
    } catch (reason) {
      if (active.current) setFailure(describeFailure(reason, "sign in"));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function switchGoogleAccount() {
    setSwitching(false);
    setFailure(null);
    setBusy(true);
    try {
      apply(await syncApi.switchAccount());
      // A Drive folder belongs to the account it was chosen with.
      if (active.current) setDestination(await attachments.uploadDestination());
    } catch (reason) {
      if (active.current)
        setFailure(describeFailure(reason, "use another account"));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const driveUnavailable =
    configured === false && destination?.kind !== "google_drive";
  return (
    <SettingsSection
      title="New files"
      caption="Files you already attached stay where they are."
    >
      <ChoiceTiles
        aria-label="New files"
        value={destination?.kind ?? ""}
        disabled={!destination || busy}
        onValueChange={(kind) => void choose(kind)}
      >
        <ChoiceTile
          value="local"
          title="This computer"
          icon={<HardDrive />}
          description="Kept beside this Workspace."
        >
          {/* Facts in words; status colour never decorates an icon. */}
          <span className="attachments-facts">
            Works offline · Included in backups
          </span>
        </ChoiceTile>
        <ChoiceTile
          value="google_drive"
          title="Google Drive"
          icon={<Cloud />}
          description="Kept in a folder in your Drive."
          disabled={driveUnavailable}
        >
          {/* The reason in the tile's own facts line. */}
          <span className="attachments-facts">
            {driveUnavailable
              ? "Not set up in this build · Not in backups"
              : onDriveDestination
                ? "Not in backups"
                : "Workspace sync’s sign-in · Not in backups"}
          </span>
        </ChoiceTile>
      </ChoiceTiles>

      {onDriveDestination && (
        <div className="attachments-folder">
          <SettingsList>
            <SettingsRow
              title="Google account"
              description={
                signedOut ? (
                  <StatusLabel tone="attention" size="caption">
                    Signed out
                  </StatusLabel>
                ) : account ? (
                  signedIn ? (
                    `${account}, the one Workspace sync uses`
                  ) : (
                    account
                  )
                ) : (
                  "The one Workspace sync uses"
                )
              }
              trailing={
                signedOut ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void signInAgain()}
                  >
                    Sign in again
                    <ExternalLink aria-hidden="true" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setSwitching(true)}
                  >
                    Use another account…
                  </Button>
                )
              }
            />
            <SettingsRow
              title="Folder"
              description={
                inSyncFolder && syncFolder
                  ? `Uploads, inside your “${syncFolder.name}” sync folder`
                  : `“${onDriveDestination.folder_name}”`
              }
              trailing={
                inSyncFolder ? undefined : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void choose("google_drive")}
                  >
                    Change folder…
                  </Button>
                )
              }
            />
          </SettingsList>
        </div>
      )}
      {/* The tiles say it by turning unavailable; nothing pushes the page. */}
      <p role="status" className="sr-only">
        {busy ? "Updating upload destination…" : ""}
      </p>
      {failure && (
        <div className="attachments-folder">
          <FailureAlert
            size="compact"
            failure={failure}
            {...(!destination && {
              onRetry: () => setReload((value) => value + 1),
            })}
          />
        </div>
      )}
      <UseAnotherAccountDialog
        open={switching}
        onOpenChange={setSwitching}
        account={account}
        sync={sync}
        onConfirm={() => void switchGoogleAccount()}
      />
    </SettingsSection>
  );
}
