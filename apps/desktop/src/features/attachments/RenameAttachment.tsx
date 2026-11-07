import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename attachment</DialogTitle>
          <DialogDescription>
            Change the display name used in the attachment browser.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="attachment-display-name">Display name</Label>
        <Input
          id="attachment-display-name"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim() && !busy) void save();
          }}
        />
        <p className="attachment-hint">
          Original filename: {file.original_filename}
        </p>
        <p className="attachment-hint">
          Existing link text stays exactly as authored. Renaming does not change
          the original filename, file bytes, or identity.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="attachment-actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            Save name
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
