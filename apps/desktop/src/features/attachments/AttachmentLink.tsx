import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { formatSize } from "./format-size";
import { DriveReferenceDetails } from "./DriveReferenceDetails";

/** An inline authored label. Metadata is resolved only after an explicit action. */
export function AttachmentLink({
  uri,
  children,
}: {
  uri: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<Attachment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="context-link"
        onClick={() => {
          setOpen(true);
          setFile(null);
          void run(async () => {
            setFile(await attachments.resolve(uri));
          });
        }}
      >
        {children}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{file?.display_name ?? "Attachment"}</DialogTitle>
            <DialogDescription>
              {file?.kind === "external_reference"
                ? "Google Drive · External reference"
                : "File in its owning workspace"}
            </DialogDescription>
          </DialogHeader>
          {busy && <p role="status">Loading file…</p>}
          {error && <p role="alert">{error}</p>}
          {file && (
            <>
              {file.kind === "external_reference" && (
                <p>
                  Current source content · No local snapshot. Google Docs,
                  Sheets and Slides open in Drive.
                </p>
              )}
              <dl className="attachment-metadata">
                {file.kind === "external_reference" && (
                  <DriveReferenceDetails id={file.id} />
                )}
                <dt>Original filename</dt>
                <dd>{file.original_filename}</dd>
                {file.kind === "local_snapshot" && (
                  <>
                    <dt>Size</dt>
                    <dd>{formatSize(file.size_bytes)}</dd>
                  </>
                )}
              </dl>
              <div className="attachment-actions">
                <Button
                  disabled={busy}
                  onClick={() => void run(() => attachments.open(file.id))}
                >
                  {file.kind === "external_reference"
                    ? "Open in Drive"
                    : "Open file"}
                </Button>
                {file.kind === "local_snapshot" && (
                  <Button
                    disabled={busy}
                    onClick={() => void run(() => attachments.export(file))}
                  >
                    Export file
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
