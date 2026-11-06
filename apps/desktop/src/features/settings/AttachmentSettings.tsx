import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { attachments } from "@/lib/api/attachments";
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
      description="Local files are copied into this workspace. Existing snapshots stay unchanged."
    >
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
      <p className="settings-hint">Destination: Local workspace</p>
      {saving && <p role="status">Saving upload limit…</p>}
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
    </SettingsCard>
  );
}
