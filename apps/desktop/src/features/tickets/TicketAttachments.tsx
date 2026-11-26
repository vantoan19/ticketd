import { useStatusLine } from "@/components/ui/use-status-line";
import { useState } from "react";
import { X } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FailureAlert } from "@/components/ui/failure-alert";
import { describeFailure } from "@/lib/api/describe-failure";
import { AttachmentPreview } from "@/features/attachments/AttachmentPreview";
import { AttachmentPicker } from "@/features/attachments/AttachmentPicker";
import { attachments, type Attachment } from "@/lib/api/attachments";
import type { Ticket } from "@/lib/api/client";
import type { TicketAttachmentsState } from "./use-ticket-attachments";

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
          // One viewer for the whole walk: Previous and Next change `selected`,
          // and what opened it keeps focus and scroll for the way back.
          target={{ id: selected.id, initial: selected }}
          browse={{
            files: state.found ?? [],
            onSelect: (file) => {
              setError(null);
              onSelected(file);
            },
          }}
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
                <X aria-hidden="true" />
                Detach from ticket
              </DropdownMenuItem>
            )
          }
        />
      )}
    </>
  );
}
