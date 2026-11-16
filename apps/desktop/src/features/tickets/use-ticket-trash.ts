import { useState } from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { client, type Ticket } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";

/**
 * Moves a ticket to Trash or restores it. The outcome goes to the pane's
 * status line: "Moved T-1 to Trash" with Undo, "Restored T-1", or the failure
 * with Retry. Nothing is inserted into the page.
 */
export function useTicketTrash(
  updateTicket: (ticket: Ticket) => void,
  refresh: () => Promise<void>,
) {
  const [pending, setPending] = useState(false);
  const statusLine = useStatusLine();
  async function restore(reference: string) {
    updateTicket(await client.setTrashed(reference, false));
    await refresh();
  }
  async function setTrashed(reference: string, value: boolean) {
    setPending(true);
    try {
      updateTicket(await client.setTrashed(reference, value));
      await refresh();
      statusLine.show(
        value
          ? {
              message: `Moved ${reference} to Trash`,
              undo: () => restore(reference),
            }
          : { message: `Restored ${reference}` },
      );
    } catch (reason) {
      const failure = describeFailure(
        reason,
        value ? `move ${reference} to Trash` : `restore ${reference}`,
      );
      statusLine.show({
        tone: "error",
        message: `${failure.title}. ${failure.sentence}`,
        details: failure.details,
        ...(failure.action === "retry" && {
          action: {
            label: "Retry",
            run: () => setTrashed(reference, value),
          },
        }),
      });
    } finally {
      setPending(false);
    }
  }
  return { pending, setTrashed };
}
