import { useEffect, useState } from "react";
import { Download, File, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AttachmentPicker } from "@/features/attachments/AttachmentPicker";
import { attachments, type Attachment } from "@/lib/api/attachments";
import type { Ticket } from "@/lib/api/client";
import { RailSection } from "./RailSection";
import "./ticket-attachments.css";
import { formatSize } from "@/features/attachments/format-size";
import { DriveReferenceDetails } from "@/features/attachments/DriveReferenceDetails";

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
                  <small>
                    {file.kind === "external_reference"
                      ? "Google Drive · External reference"
                      : `${formatSize(file.size_bytes)} · Local snapshot`}
                  </small>
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
        ticketReference={ticket.reference}
        open={picker}
        onOpenChange={setPicker}
        onPick={async (file, requestId) => {
          await attachments.setTicket(
            ticket.reference,
            file.id,
            true,
            requestId,
          );
          changed();
        }}
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
              {selected?.kind === "external_reference"
                ? "Google Drive · Current source content · No local snapshot"
                : "Local snapshot · Stored in this workspace"}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <dl className="attachment-metadata">
                {selected.kind === "external_reference" && (
                  <DriveReferenceDetails id={selected.id} />
                )}
                <dt>Original filename</dt>
                <dd>{selected.original_filename}</dd>
                {selected.kind === "local_snapshot" && (
                  <>
                    <dt>Size</dt>
                    <dd>{formatSize(selected.size_bytes)}</dd>
                  </>
                )}
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
                  {selected.kind === "external_reference"
                    ? "Open in Drive"
                    : "Open file"}
                </Button>
                {selected.kind === "local_snapshot" && (
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
                )}
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
