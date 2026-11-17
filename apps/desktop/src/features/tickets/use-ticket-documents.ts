import { useMemo, useRef, useState } from "react";
import {
  documents,
  type DocumentLink,
  type DocumentSummary,
} from "@/features/documents/api";
import { describeFailure } from "@/lib/api/describe-failure";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  relinkedDocumentFill,
  unlinkedDocumentFill,
  useOpenTicket,
  type Fill,
} from "./open-ticket";

/**
 * The Documents a ticket links to, one per Document by its strongest source
 * (attached, then mentioned in the description, then in an update), read
 * through the Open Ticket. Trashing a Document elsewhere does not change the
 * ticket, but it does change the workspace, which reads them again.
 */
export function useTicketDocuments() {
  const { reference, record, changed } = useOpenTicket();
  const read = useOpenTicket("documents");
  const [error, setError] = useState<FailureDescription | null>(null);
  const statusLine = useStatusLine();
  // Documents being removed: hidden at once, and their Remove ignored until
  // the write answers (the ref covers a second click before the next render).
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const writing = useRef(new Set<string>());
  // Null until the first read answers: an unread list never reads as empty.
  const links = useMemo(
    () => read.links?.filter((link) => !removing.has(link.target_id)) ?? null,
    [read.links, removing],
  );
  /** `fills` is what the change set in the list, reported once it is saved. */
  async function change(id: string, present: boolean, fills: readonly Fill[]) {
    setError(null);
    try {
      await documents.setTicketDocument(reference, id, present);
      await changed(undefined, fills);
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
  /** Removes the link; the pane's status line offers Undo (P7). */
  async function unlink(link: DocumentLink) {
    const id = link.target_id;
    if (writing.current.has(id)) return;
    writing.current.add(id);
    setRemoving((old) => new Set(old).add(id));
    const removed = await change(id, false, [unlinkedDocumentFill(record, id)]);
    writing.current.delete(id);
    setRemoving((old) => {
      const next = new Set(old);
      next.delete(id);
      return next;
    });
    if (!removed) {
      void read.retry();
      return;
    }
    statusLine.show({
      message: `Removed ${link.target_label} from ${reference}`,
      undo: async () => {
        await documents.setTicketDocument(reference, link.target_id, true);
        // Shown again now, and kept if the re-read that follows fails.
        await changed(undefined, [relinkedDocumentFill(record, link)]);
      },
    });
  }
  async function add(picked: DocumentSummary) {
    await change(picked.id, true, []);
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
