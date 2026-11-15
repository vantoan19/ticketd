import { useEffect, useState } from "react";
import { File, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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
  // Null until the first read answers: an unread section never claims "no files".
  const [found, setFound] = useState<Attachment[] | null>(null);
  const files = found ?? [];
  const [visits, setVisits] = useState(0);
  // A failed read and a failed action are told apart: the read replaces the
  // list, the action shows where it was taken.
  const [loadFailure, setLoadFailure] = useState<FailureDescription | null>(
    null,
  );
  const [error, setError] = useState<FailureDescription | null>(null);
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
      .then((list) => {
        if (current) {
          setFound(list);
          setLoadFailure(null);
        }
      })
      .catch((reason: unknown) => {
        if (current)
          setLoadFailure(describeFailure(reason, "load attachments"));
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
    void refresh().catch((reason: unknown) =>
      setError(describeFailure(reason, "refresh the ticket")),
    );
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (reason) {
      setError(describeFailure(reason, "detach the file"));
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
                  setError(null);
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
        {loadFailure && found === null && (
          <FailureState
            size="inline"
            failure={loadFailure}
            onRetry={() => setVisits((value) => value + 1)}
          />
        )}
        {/* An empty section shows only its action; a trashed ticket has none. */}
        {found?.length === 0 && ticket.trashed && (
          <p className="attachment-hint">No attached files</p>
        )}
        {!ticket.trashed && (
          <Button variant="ghost" size="sm" onClick={() => setPicker(true)}>
            <Plus aria-hidden="true" />
            Attach file
          </Button>
        )}
        {error && !selected && <FailureAlert size="compact" failure={error} />}
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
              {error && <FailureAlert size="compact" failure={error} />}
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
