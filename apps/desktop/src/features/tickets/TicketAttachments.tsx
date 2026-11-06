import { useEffect, useRef, useState } from "react";
import { Download, File, Plus, Upload } from "lucide-react";
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
import type { Ticket } from "@/lib/api/client";
import { RailSection } from "./RailSection";
import "./ticket-attachments.css";

type UploadAttempt = {
  source: string;
  requestId: string;
  linkRequestId: string;
  stored?: Attachment;
};

export function TicketAttachments({
  ticket,
  revision,
  refresh,
}: {
  ticket: Ticket;
  revision: number;
  refresh: () => Promise<void>;
}) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [visits, setVisits] = useState(0);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState(false);
  const [selected, setSelected] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const again = () => setVisits((value) => value + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  useEffect(() => {
    let current = true;
    void attachments
      .forTicket(ticket.reference)
      .then((found) => {
        if (current) {
          setFiles(found);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [ticket.reference, revision, visits]);
  function changed() {
    setVisits((value) => value + 1);
    void refresh().catch((reason: unknown) => setError(String(reason)));
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <RailSection label="Attachments">
      <div className="ticket-attachments">
        <ul aria-label="Directly attached files">
          {files.map((file) => (
            <li key={file.id}>
              <button
                className="attachment-row"
                aria-label={file.display_name}
                type="button"
                onClick={() => {
                  setError("");
                  setSelected(file);
                }}
              >
                <File aria-hidden="true" />
                <span>
                  {file.display_name}
                  <small>{formatSize(file.size_bytes)} · Local snapshot</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!files.length && (
          <p className="attachment-hint">No directly attached files</p>
        )}
        {!ticket.trashed && (
          <Button variant="ghost" size="sm" onClick={() => setPicker(true)}>
            <Plus aria-hidden="true" />
            Attach file
          </Button>
        )}
        {error && !selected && <p role="alert">{error}</p>}
      </div>
      <AttachmentPicker
        open={picker}
        onOpenChange={setPicker}
        reference={ticket.reference}
        onChanged={changed}
      />
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected?.display_name ?? "Attachment"}</DialogTitle>
            <DialogDescription>
              Local snapshot · Stored in this workspace
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <dl className="attachment-metadata">
                <dt>Original filename</dt>
                <dd>{selected.original_filename}</dd>
                <dt>Size</dt>
                <dd>{formatSize(selected.size_bytes)}</dd>
                <dt>Attachment ID</dt>
                <dd>
                  <code>{selected.id}</code>
                </dd>
              </dl>
              <p className="attachment-hint">
                Files in linked Documents stay with their Documents. Detaching
                removes only this ticket’s association.
              </p>
              {error && <p role="alert">{error}</p>}
              <div className="attachment-actions">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(() => attachments.open(selected.id))
                  }
                >
                  Open file
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(() => attachments.export(selected))
                  }
                >
                  <Download aria-hidden="true" />
                  Export file
                </Button>
                {!ticket.trashed && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await attachments.setTicket(
                          ticket.reference,
                          selected.id,
                          false,
                          crypto.randomUUID(),
                        );
                        setSelected(null);
                        changed();
                      })
                    }
                  >
                    Detach from ticket
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </RailSection>
  );
}

function AttachmentPicker({
  open,
  onOpenChange,
  reference,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reference: string;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"upload" | "existing">("upload");
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
      await attachments.setTicket(reference, file.id, true, next.linkRequestId);
      setAttempt(null);
      changeOpen(false);
      onChanged();
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
      await attachments.setTicket(
        reference,
        attachmentId.trim(),
        true,
        crypto.randomUUID(),
      );
      onOpenChange(false);
      onChanged();
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
            Attach a local snapshot or reuse an existing workspace file.
          </DialogDescription>
        </DialogHeader>
        <SegmentedControl
          aria-label="Attachment source"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "upload", label: "Upload", disabled: busy },
            { value: "existing", label: "Existing files", disabled: busy },
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
                        {formatSize(file.size_bytes)} · {file.id}
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

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${bytes} B`;
}
