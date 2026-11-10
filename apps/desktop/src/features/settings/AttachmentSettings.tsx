import { useEffect, useRef, useState } from "react";
import { RadioGroup } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  attachments,
  type AttachmentUploadDestination,
  type DriveConfiguration,
} from "@/lib/api/attachments";
import { DriveSetupNotice } from "@/features/attachments/DriveSetupNotice";
import { SettingsCard } from "./SettingsCard";

export function AttachmentSettings() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    void attachments
      .uploadLimit()
      .then((bytes) => {
        if (current) {
          setValue(String(bytes / 1048576));
          setSaved(bytes);
        }
      })
      .catch((reason: unknown) => {
        if (current)
          setFailure(`Could not read the upload limit: ${String(reason)}`);
      });
    return () => {
      current = false;
    };
  }, []);
  async function save() {
    const bytes = Number(value) * 1048576;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      setFailure("Enter a positive upload limit in MiB.");
      return;
    }
    if (bytes === saved) return;
    setSaving(true);
    setFailure("");
    try {
      await attachments.setUploadLimit(bytes);
      setSaved(bytes);
    } catch (reason) {
      setFailure(`Could not save the upload limit: ${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsCard
      id="attachments"
      title="Attachments"
      description="Choose where new uploads are stored. Existing attachments stay where they are."
    >
      <UploadDestinationSettings />
      <div className="settings-row">
        <div>
          <Label htmlFor="attachment-upload-limit">Upload limit (MiB)</Label>
          <p className="settings-hint">
            Per file, for future uploads. Default: 100 MiB. All file types are
            accepted.
          </p>
        </div>
        <Input
          id="attachment-upload-limit"
          type="number"
          min={1 / 1048576}
          step="any"
          value={value}
          disabled={saved === null || saving}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
      {saving && <p role="status">Saving upload limit…</p>}
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
    </SettingsCard>
  );
}

function UploadDestinationSettings() {
  const [destination, setDestination] =
    useState<AttachmentUploadDestination | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [configuration, setConfiguration] = useState<DriveConfiguration | null>(
    null,
  );
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
          setFailure("");
        }
      })
      .catch((reason: unknown) => {
        if (current)
          setFailure(
            `Could not read the upload destination: ${String(reason)}`,
          );
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
  async function choose(kind: string) {
    setFailure("");
    setBusy(true);
    try {
      let selected = null;
      if (kind === "google_drive") {
        const config = await attachments.driveConfiguration();
        if (!active.current) return;
        setConfiguration(config);
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
        setFailure(`Upload destination unchanged: ${String(reason)}`);
    } finally {
      selection.current = null;
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="settings-row settings-row-stacked">
        <div>
          <p id="upload-destination-label" className="settings-label">
            Upload destination
          </p>
          <p className="settings-hint">
            Applies to new uploads only. Queued uploads and retries keep their
            original destination.
          </p>
        </div>
        <RadioGroup.Root
          aria-labelledby="upload-destination-label"
          value={destination?.kind ?? ""}
          disabled={!destination || busy}
          onValueChange={(kind) => void choose(kind)}
          className="upload-destination-choices"
        >
          <RadioGroup.Item value="local" className="upload-destination-choice">
            <span className="layout-choice-dot" aria-hidden="true" />
            <span>
              Local workspace
              <small>Available offline · Included in backups</small>
            </span>
          </RadioGroup.Item>
          <RadioGroup.Item
            value="google_drive"
            className="upload-destination-choice"
          >
            <span className="layout-choice-dot" aria-hidden="true" />
            <span>
              Google Drive<small>Uploads a separate copy to Drive</small>
            </span>
          </RadioGroup.Item>
        </RadioGroup.Root>
      </div>
      {destination?.kind === "google_drive" && (
        <div className="settings-row">
          <div>
            <p className="settings-label">Upload folder</p>
            <p className="settings-hint">{destination.folder_name}</p>
            <p className="settings-hint">
              Writable when selected. Checked again before upload.
            </p>
          </div>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void choose("google_drive")}
          >
            Change folder
          </Button>
        </div>
      )}
      {busy && <p role="status">Updating upload destination…</p>}
      {configuration && <DriveSetupNotice configuration={configuration} />}
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
      {!destination && failure && (
        <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
          Retry destination
        </Button>
      )}
      <p className="settings-hint">
        Drive failures never switch storage automatically. Sharing stays
        unchanged; removing an attachment keeps its file in Drive.
      </p>
    </>
  );
}
