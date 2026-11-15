import { useState } from "react";
import { File } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { describeFailure } from "@/lib/api/describe-failure";
import { AttachmentPreview } from "@/features/attachments/AttachmentPreview";
import { AttachmentPicker } from "@/features/attachments/AttachmentPicker";
import { attachments, type Attachment } from "@/lib/api/attachments";
import type { Ticket } from "@/lib/api/client";
import { formatSize } from "@/features/attachments/format-size";
import {
  storageWord,
  useAvailability,
} from "@/features/sync-review/availability";
import { FileRow } from "./FileRow";
import type { TicketAttachmentsState } from "./use-ticket-attachments";

/** The attached files as rows; each opens its preview. */
export function AttachmentRows({
  files,
  onOpen,
}: {
  files: Attachment[];
  onOpen: (file: Attachment) => void;
}) {
  const availability = useAvailability(
    files
      .filter((file) => file.kind !== "external_reference")
      .map((file) => file.id),
  );
  return files.map((file) => (
    <FileRow
      key={file.id}
      icon={<File aria-hidden="true" />}
      name={file.display_name}
      caption={
        file.kind === "external_reference"
          ? file.uploaded_copy
            ? "Google Drive · Uploaded copy"
            : "Google Drive · External reference"
          : `${formatSize(file.size_bytes)} · ${storageWord(availability.of(file.id))}`
      }
      onOpen={() => onOpen(file)}
    />
  ));
}

/** The Attach file picker and a file's preview, with Detach from ticket. */
export function AttachmentDialogs({
  ticket,
  state,
  picker,
  onPickerChange,
  selected,
  onSelected,
}: {
  ticket: Ticket;
  state: TicketAttachmentsState;
  picker: boolean;
  onPickerChange: (open: boolean) => void;
  selected: Attachment | null;
  onSelected: (file: Attachment | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { error, setError, changed } = state;
  async function detach(file: Attachment) {
    setBusy(true);
    setError(null);
    try {
      await attachments.setTicket(
        ticket.reference,
        file.id,
        false,
        crypto.randomUUID(),
      );
      onSelected(null);
      changed();
    } catch (reason) {
      setError(describeFailure(reason, "detach the file"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <AttachmentPicker
        ticketReference={ticket.reference}
        open={picker}
        onOpenChange={onPickerChange}
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
          onClose={() => onSelected(null)}
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
                  onClick={() => void detach(selected)}
                >
                  Detach from ticket
                </Button>
              )}
            </>
          }
        />
      )}
    </>
  );
}
