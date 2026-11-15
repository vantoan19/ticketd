import { useRef, useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { attachments, type Attachment } from "@/lib/api/attachments";

export function RenameAttachment({
  file,
  onClose,
  onRenamed,
}: {
  file: Attachment;
  onClose: () => void;
  onRenamed: (file: Attachment) => void;
}) {
  const [name, setName] = useState(file.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ name: string; id: string } | null>(null);
  async function save() {
    setBusy(true);
    setError("");
    if (request.current?.name !== name)
      request.current = { name, id: crypto.randomUUID() };
    try {
      const renamed = await attachments.rename(
        file.id,
        name,
        request.current.id,
      );
      onRenamed(renamed);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      title="Rename attachment"
      description="Change the display name used in the attachment browser."
      primaryLabel="Save name"
      blockedReason={
        busy ? "Saving…" : name.trim() ? null : "Enter a display name."
      }
      busy={busy}
      error={error || undefined}
      onSubmit={() => void save()}
    >
      <Label htmlFor="attachment-display-name">Display name</Label>
      <Input
        id="attachment-display-name"
        value={name}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
      <p className="attachment-hint">
        Original filename: {file.original_filename}
      </p>
      <p className="attachment-hint">
        Existing link text stays exactly as authored. Renaming does not change
        the original filename, file bytes, or identity.
      </p>
    </DialogShell>
  );
}
