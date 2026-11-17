import { useState } from "react";
import {
  documents,
  type DocumentLink,
  type DocumentSummary,
} from "@/features/documents/api";
import { describeFailure } from "@/lib/api/describe-failure";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { useStatusLine } from "@/components/ui/use-status-line";
import { useOpenTicket } from "./open-ticket";

/**
 * The Documents a ticket links to, one per Document by its strongest source
 * (attached, then mentioned in the description, then in an update), read
 * through the Open Ticket. Trashing a Document elsewhere does not change the
 * ticket, but it does change the workspace, which reads them again.
 */
export function useTicketDocuments() {
  const { reference, changed } = useOpenTicket();
  const read = useOpenTicket("documents");
  const [error, setError] = useState<FailureDescription | null>(null);
  const statusLine = useStatusLine();
  // A removed link leaves at once; the next authoritative read replaces this.
  const [removed, setRemoved] = useState<{
    base: DocumentLink[] | undefined;
    ids: string[];
  }>({ base: undefined, ids: [] });
  const ids = removed.base === read.links ? removed.ids : [];
  // Null until the first read answers: an unread list never reads as empty.
  const links =
    read.links?.filter((link) => !ids.includes(link.target_id)) ?? null;
  async function change(id: string, present: boolean) {
    setError(null);
    try {
      await documents.setTicketDocument(reference, id, present);
      await changed();
      return true;
    } catch (reason) {
      setError(
        describeFailure(
          reason,
          present ? "attach the Document" : "remove the Document",
        ),
      );
      return false;
    }
  }
  /** Removes the link at once; the pane's status line offers Undo (P7). */
  async function unlink(link: DocumentLink) {
    setRemoved({ base: read.links, ids: [...ids, link.target_id] });
    if (!(await change(link.target_id, false))) {
      setRemoved({ base: undefined, ids: [] });
      read.retry();
      return;
    }
    statusLine.show({
      message: `Removed ${link.target_label} from ${reference}`,
      undo: async () => {
        await documents.setTicketDocument(reference, link.target_id, true);
        // Show it again now, whatever the next read holds.
        setRemoved((current) => ({
          ...current,
          ids: current.ids.filter((id) => id !== link.target_id),
        }));
        await changed();
      },
    });
  }
  async function add(picked: DocumentSummary) {
    await change(picked.id, true);
  }
  return {
    links,
    error,
    loadFailure: read.failure,
    retry: read.retry,
    unlink,
    add,
  };
}
