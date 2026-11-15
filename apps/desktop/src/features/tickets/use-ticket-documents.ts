import { useEffect, useState } from "react";
import { documents, type DocumentSummary } from "@/features/documents/api";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useStatusLine } from "@/components/ui/use-status-line";
import { type Ticket } from "@/lib/api/client";

export type DocumentLink = Awaited<
  ReturnType<typeof documents.links>
>[0][number];

const sourceRank = (link: DocumentLink) =>
  link.explicit ? 0 : link.activity_id ? 2 : 1;

/**
 * The Documents a ticket links to, one per Document by its strongest source
 * (attached, then mentioned in the description, then in an update). It reads
 * again on a new workspace revision and when the window comes back, since
 * trashing a Document elsewhere does not change the ticket.
 */
export function useTicketDocuments({
  ticket,
  revision,
  refresh,
}: {
  ticket: Ticket;
  revision: number;
  refresh: () => Promise<void>;
}) {
  // Null until the first read answers: an unread list never reads as empty.
  const [links, setLinks] = useState<DocumentLink[] | null>(null);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [loadFailure, setLoadFailure] = useState<FailureDescription | null>(
    null,
  );
  const statusLine = useStatusLine();
  const [visits, setVisits] = useState(0);
  useEffect(() => {
    const again = () => setVisits((value) => value + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  useEffect(() => {
    let current = true;
    void documents
      .links(ticket.id)
      .then(([outgoing]) => {
        if (!current) return;
        const byDocument = new Map<string, DocumentLink>();
        for (const link of outgoing) {
          if (link.target_kind !== "document") continue;
          const known = byDocument.get(link.target_id);
          if (!known || sourceRank(link) < sourceRank(known))
            byDocument.set(link.target_id, link);
        }
        // Attached Documents list first, like the CLI's context.
        setLinks(
          [...byDocument.values()].sort(
            (a, b) => sourceRank(a) - sourceRank(b),
          ),
        );
        setLoadFailure(null);
      })
      .catch((reason: unknown) => {
        if (current) setLoadFailure(describeFailure(reason, "load Documents"));
      });
    return () => {
      current = false;
    };
  }, [ticket.id, ticket.body, revision, visits]);
  async function change(id: string, present: boolean) {
    setError(null);
    try {
      await documents.setTicketDocument(ticket.reference, id, present);
      setVisits((value) => value + 1);
      await refresh();
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
    setLinks(
      (current) =>
        current?.filter((item) => item.target_id !== link.target_id) ?? null,
    );
    if (!(await change(link.target_id, false))) {
      setVisits((value) => value + 1);
      return;
    }
    statusLine.show({
      message: `Removed ${link.target_label} from ${ticket.reference}`,
      undo: async () => {
        await documents.setTicketDocument(
          ticket.reference,
          link.target_id,
          true,
        );
        setVisits((value) => value + 1);
        await refresh();
      },
    });
  }
  async function add(picked: DocumentSummary) {
    await change(picked.id, true);
  }
  return {
    links,
    error,
    loadFailure,
    retry: () => setVisits((value) => value + 1),
    unlink,
    add,
  };
}
