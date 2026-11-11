import { useEffect, useState } from "react";
import { File, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AttachmentPreview } from "@/features/attachments/AttachmentPreview";
import { AttachmentPicker } from "@/features/attachments/AttachmentPicker";
import { attachments, type Attachment } from "@/lib/api/attachments";
import type { Ticket } from "@/lib/api/client";
import { RailSection } from "./RailSection";
import "./ticket-attachments.css";
import { formatSize } from "@/features/attachments/format-size";
import {
  storageWord,
  useAvailability,
} from "@/features/sync-review/availability";

type Props = {
  ticket: Ticket;
  revision: number;
  refresh: () => Promise<void>;
};

export function TicketAttachments(props: Props) {
  return <TicketAttachmentFiles key={props.ticket.id} {...props} />;
}

function TicketAttachmentFiles({ ticket, revision, refresh }: Props) {
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
  const availability = useAvailability(
    files
      .filter((file) => file.kind !== "external_reference")
      .map((file) => file.id),
  );
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
                      ? file.uploaded_copy
                        ? "Google Drive · Uploaded copy"
                        : "Google Drive · External reference"
                      : `${formatSize(file.size_bytes)} · ${storageWord(availability.of(file.id))}`}
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
      {selected && (
        <AttachmentPreview
          key={selected.id}
          target={{ id: selected.id, initial: selected }}
          onClose={() => setSelected(null)}
          onReplace={
            ticket.trashed
              ? undefined
              : async (replacement, requestId) => {
                  await attachments.replaceTicket(
                    ticket.reference,
                    selected.id,
                    replacement.id,
                    requestId,
                  );
                  changed();
                }
          }
          actions={
            <>
              {error && <p role="alert">{error}</p>}
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
            </>
          }
        />
      )}
    </RailSection>
  );
}
