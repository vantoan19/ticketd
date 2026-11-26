import { useStatusLine } from "@/components/ui/use-status-line";
import { useState } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FailureAlert } from "@/components/ui/failure-alert";
import { describeFailure } from "@/lib/api/describe-failure";
import { AttachmentPreview } from "@/features/attachments/AttachmentPreview";
import { AttachmentPicker } from "@/features/attachments/AttachmentPicker";
import { attachments, type Attachment } from "@/lib/api/attachments";
import type { Ticket } from "@/lib/api/client";
import { AttachmentCard } from "@/features/attachments/AttachmentCard";
import { useAvailability } from "@/features/sync-review/availability";
import type { TicketAttachmentsState } from "./use-ticket-attachments";

/** The attached files as cards; each opens its preview. */
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
    <li key={file.id} className="file-card-item">
      <AttachmentCard
        file={file}
        storage={availability.of(file.id)}
        onOpen={() => onOpen(file)}
      />
    </li>
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
  fallbackFocus,
}: {
  ticket: Ticket;
  state: TicketAttachmentsState;
  picker: boolean;
  onPickerChange: (open: boolean) => void;
  selected: Attachment | null;
  onSelected: (file: Attachment | null) => void;
  /** Where focus goes when the file that was open is gone (the Files heading). */
  fallbackFocus?: () => HTMLElement | null;
}) {
  const [busy, setBusy] = useState(false);
  const statusLine = useStatusLine();
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
      const restoreId = crypto.randomUUID();
      statusLine.show({
        message: `Detached ${file.display_name}`,
        undo: async () => {
          await attachments.setTicket(
            ticket.reference,
            file.id,
            true,
            restoreId,
          );
          changed();
        },
      });
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
          {...(fallbackFocus && { fallbackFocus })}
          notice={error && <FailureAlert size="compact" failure={error} />}
          menuItems={
            !ticket.trashed && (
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => void detach(selected)}
              >
                Detach from ticket
              </DropdownMenuItem>
            )
          }
        />
      )}
    </>
  );
}
