import { DrivePicker } from "./DrivePicker";
import { formatSize } from "./format-size";
import { useEffect, useRef, useState } from "react";
import { File, Upload } from "lucide-react";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { attachments, type Attachment } from "@/lib/api/attachments";
import "@/features/tickets/ticket-attachments.css";

type UploadAttempt = {
  source: string;
  requestId: string;
  linkRequestId: string;
  stored?: Attachment;
};

export function AttachmentPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (
    file: Attachment,
    requestId: string,
    beforeId?: string,
  ) => Promise<void>;
}) {
  const [tab, setTab] = useState<"upload" | "existing" | "drive">("upload");
  const [recent, setRecent] = useState<Attachment[]>([]);
  const [id, setId] = useState("");
  const [attempt, setAttempt] = useState<UploadAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const insertion = useRef(0);
  useEffect(
    () => () => {
      insertion.current += 1;
    },
    [],
  );
  function changeOpen(next: boolean) {
    if (!next) insertion.current += 1;
    onOpenChange(next);
  }
  useEffect(() => {
    let current = true;
    if (open && tab === "existing")
      void attachments
        .recent()
        .then((files) => {
          if (current) setRecent(files);
        })
        .catch((reason: unknown) => {
          if (current) setError(String(reason));
        });
    return () => {
      current = false;
    };
  }, [open, tab]);
  async function upload(next: UploadAttempt) {
    const currentInsertion = insertion.current;
    setAttempt(next);
    setBusy(true);
    setError("");
    try {
      const file =
        next.stored ?? (await attachments.upload(next.source, next.requestId));
      next = { ...next, stored: file };
      setAttempt(next);
      if (insertion.current !== currentInsertion) return;
      await onPick(file, next.linkRequestId);
      setAttempt(null);
      changeOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function choose() {
    const currentInsertion = insertion.current;
    setBusy(true);
    setError("");
    try {
      const source = await attachments.chooseFile();
      if (source && insertion.current === currentInsertion)
        await upload({
          source,
          requestId: crypto.randomUUID(),
          linkRequestId: crypto.randomUUID(),
        });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function reuse(attachmentId: string) {
    setBusy(true);
    setError("");
    try {
      const currentInsertion = insertion.current;
      const file = await attachments.inspect(attachmentId.trim());
      if (insertion.current !== currentInsertion) return;
      await onPick(file, crypto.randomUUID());
      changeOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach file</DialogTitle>
          <DialogDescription>
            Upload, reuse a workspace file, or select a Google Drive reference.
          </DialogDescription>
        </DialogHeader>
        <SegmentedControl
          aria-label="Attachment source"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "upload", label: "Upload", disabled: busy },
            { value: "existing", label: "Existing files", disabled: busy },
            { value: "drive", label: "Google Drive", disabled: busy },
          ]}
        />
        {tab === "upload" ? (
          <div className="attachment-upload">
            <Upload aria-hidden="true" />
            <p>Choose a file from your computer</p>
            <p className="attachment-hint">
              Any file type · Up to 100 MiB per file
            </p>
            <Button disabled={busy} onClick={() => void choose()}>
              Choose file
            </Button>
            <small>Destination: Local workspace</small>
          </div>
        ) : tab === "drive" ? (
          open && (
            <DrivePicker
              onComplete={() => changeOpen(false)}
              onPick={async (file, requestId, beforeId) => {
                if (beforeId) await onPick(file, requestId, beforeId);
                else await onPick(file, requestId);
              }}
            />
          )
        ) : (
          <div className="attachment-existing">
            <Label htmlFor="reuse-attachment-id">Attachment ID</Label>
            <div className="attachment-actions">
              <Input
                id="reuse-attachment-id"
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
              <Button
                disabled={busy || !id.trim()}
                onClick={() => void reuse(id)}
              >
                Reuse ID
              </Button>
            </div>
            <p className="attachment-hint">Recent workspace files</p>
            <ul aria-label="Existing files">
              {recent.map((file) => (
                <li key={file.id}>
                  <button
                    className="attachment-row"
                    type="button"
                    disabled={busy}
                    onClick={() => void reuse(file.id)}
                  >
                    <File aria-hidden="true" />
                    <span>
                      {file.display_name}
                      <small>
                        {file.kind === "external_reference"
                          ? "Google Drive · External reference"
                          : formatSize(file.size_bytes)}{" "}
                        · {file.id}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {busy && (
          <p role="status">
            {attempt?.stored ? "Attaching file…" : "Storing file…"}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {attempt?.stored && (
          <p className="attachment-hint">
            Stored as {attempt.stored.id}. The snapshot remains available even
            if you close this dialog.
          </p>
        )}
        {attempt && !busy && error && (
          <Button onClick={() => void upload(attempt)}>Retry</Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
