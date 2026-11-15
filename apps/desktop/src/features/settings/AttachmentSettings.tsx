import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useEffect, useRef, useState } from "react";
import { Check, Cloud, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { FailureAlert } from "@/components/ui/failure-alert";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusLabel } from "@/components/ui/status-label";
import {
  attachments,
  type AttachmentUploadDestination,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { SettingsSection } from "./layout/SettingsSection";
import { SettingsList, SettingsRow } from "./layout/SettingsList";
import { useSettingsState } from "./use-settings-state";
import "./pages/attachments.css";

const MIB = 1048576;
const DEFAULT_LIMIT_BYTES = 100 * MIB;

/** The Attachments page's content: where new uploads go, and the largest file. */
export function AttachmentSettings() {
  return (
    <>
      <UploadDestinationSettings />
      <UploadLimitSettings />
    </>
  );
}

function UploadLimitSettings() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  // A value that cannot be a limit: said under the field, nothing is sent.
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    void attachments
      .uploadLimit()
      .then((bytes) => {
        if (current) {
          setValue(String(bytes / MIB));
          setSaved(bytes);
        }
      })
      .catch((reason: unknown) => {
        if (current)
          setFailure(describeFailure(reason, "read the upload limit"));
      });
    return () => {
      current = false;
    };
  }, [reload]);
  async function save(text: string) {
    const bytes = Number(text) * MIB;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      setConfirmed(false);
      setFailure(null);
      setInvalid(true);
      return;
    }
    setInvalid(false);
    // Back to the saved value: nothing to send, and an earlier failure is moot.
    if (bytes === saved) {
      setFailure(null);
      return;
    }
    setSaving(true);
    setConfirmed(false);
    setFailure(null);
    try {
      await attachments.setUploadLimit(bytes);
      setSaved(bytes);
      setConfirmed(true);
    } catch (reason) {
      setFailure(describeFailure(reason, "save the upload limit"));
    } finally {
      setSaving(false);
    }
  }
  const isDefault = Number(value) * MIB === DEFAULT_LIMIT_BYTES;
  return (
    <SettingsSection title="Upload limit">
      <SettingsList>
        <SettingsRow
          variant="top"
          title={
            <Label htmlFor="attachment-upload-limit">
              Largest file<span className="sr-only"> in MiB</span>
            </Label>
          }
          description="Per file, for future uploads. All file types are accepted."
          descriptionId="attachment-upload-limit-description"
          trailing={
            <div className="attachments-limit">
              <span className="attachments-limit-field">
                <Input
                  id="attachment-upload-limit"
                  className="w-24 text-right"
                  type="number"
                  min={1 / MIB}
                  step="any"
                  value={value}
                  disabled={saved === null || saving}
                  aria-invalid={invalid || undefined}
                  aria-describedby={
                    invalid
                      ? "attachment-upload-limit-description attachment-upload-limit-error"
                      : "attachment-upload-limit-description"
                  }
                  onChange={(event) => {
                    setValue(event.target.value);
                    setConfirmed(false);
                  }}
                  onBlur={() => void save(value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <span aria-hidden="true">MiB</span>
              </span>
              {saved !== null && !invalid && !isDefault && (
                <SettingsLink
                  disabled={saving}
                  onClick={() => {
                    setValue("100");
                    void save("100");
                  }}
                >
                  Use the default, 100 MiB
                </SettingsLink>
              )}
              {saved !== null && !invalid && isDefault && (
                <span className="attachments-limit-note">Default</span>
              )}
              <span role="status" className="attachments-limit-note">
                {saving ? "Saving upload limit…" : confirmed ? "Saved" : ""}
              </span>
            </div>
          }
        >
          {invalid && (
            <FieldError id="attachment-upload-limit-error">
              Enter a size above 0 MiB.
            </FieldError>
          )}
          {failure && (
            <FailureAlert
              size="compact"
              failure={failure}
              onRetry={() => {
                setFailure(null);
                if (saved === null) setReload((count) => count + 1);
                else void save(value);
              }}
            />
          )}
        </SettingsRow>
      </SettingsList>
    </SettingsSection>
  );
}

function UploadDestinationSettings() {
  const { openPage } = useSettingsState();
  const [destination, setDestination] =
    useState<AttachmentUploadDestination | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [busy, setBusy] = useState(false);
  // Unknown (null) until Drive's configuration is read; only a definite "no"
  // disables the Drive tile.
  const [configured, setConfigured] = useState<boolean | null>(null);
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
        if (current) setConfigured(config.configured);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  async function choose(kind: string) {
    setFailure(null);
    setBusy(true);
    try {
      let selected = null;
      if (kind === "google_drive") {
        const config = await attachments.driveConfiguration();
        if (!active.current) return;
        setConfigured(config.configured);
        if (!config.configured) return;
        const operation = crypto.randomUUID();
        selection.current = operation;
        selected = (await attachments.chooseDriveFolder(operation)).destination;
        if (!active.current) return;
      }
      const saved = await attachments.setUploadDestination(selected);
      if (active.current) setDestination(saved);
    } catch (reason) {
      if (active.current)
        setFailure(describeFailure(reason, "change the upload destination"));
    } finally {
      selection.current = null;
      if (active.current) setBusy(false);
    }
  }
  const driveUnavailable =
    configured === false && destination?.kind !== "google_drive";
  return (
    <SettingsSection
      title="Upload destination"
      caption="Applies to new uploads only. Queued uploads and retries keep their original destination."
    >
      <ChoiceTiles
        aria-label="Upload destination"
        value={destination?.kind ?? ""}
        disabled={!destination || busy}
        onValueChange={(kind) => void choose(kind)}
      >
        <ChoiceTile
          value="local"
          title="Local workspace"
          icon={<HardDrive size={18} />}
          description="Files are stored beside the workspace on this computer."
        >
          <span className="attachments-facts">
            <span>
              <Check size={12} aria-hidden="true" />
              Available offline
            </span>
            <span>
              <Check size={12} aria-hidden="true" />
              Included in backups
            </span>
          </span>
        </ChoiceTile>
        <ChoiceTile
          value="google_drive"
          title="Google Drive"
          icon={<Cloud size={18} />}
          description="Uploads a separate copy to a folder in your Drive."
          disabled={driveUnavailable}
        >
          {driveUnavailable && (
            <StatusLabel tone="neutral" size="caption">
              Connect Google Drive to choose this
            </StatusLabel>
          )}
        </ChoiceTile>
      </ChoiceTiles>
      {driveUnavailable && (
        <p className="attachments-note">
          <SettingsLink onClick={() => openPage("google-drive")}>
            Set up Google Drive
          </SettingsLink>{" "}
          to store new uploads there.
        </p>
      )}
      {destination?.kind === "google_drive" && (
        <div className="attachments-folder">
          <SettingsList>
            <SettingsRow
              title="Upload folder"
              description={
                <>
                  <span className="attachments-mono">
                    {destination.folder_name}
                  </span>{" "}
                  · Writable when selected. Checked again before each upload.
                </>
              }
              trailing={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void choose("google_drive")}
                >
                  Change folder…
                </Button>
              }
            />
          </SettingsList>
        </div>
      )}
      {busy && (
        <p role="status" className="attachments-note">
          Updating upload destination…
        </p>
      )}
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
      <p className="attachments-note">
        Drive failures never switch storage automatically. Sharing stays
        unchanged; removing an attachment keeps its file in Drive.
      </p>
    </SettingsSection>
  );
}
