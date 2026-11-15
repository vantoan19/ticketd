import { useEffect, useState } from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { attachments, type Attachment } from "@/lib/api/attachments";
import type { Ticket } from "@/lib/api/client";

/**
 * The files attached directly to a ticket, read again on a new workspace
 * revision and when the window comes back.
 */
export function useTicketAttachments({
  ticket,
  revision,
  refresh,
}: {
  ticket: Ticket;
  revision: number;
  refresh: () => Promise<void>;
}) {
  // Null until the first read answers: an unread section never claims "no files".
  const [found, setFound] = useState<Attachment[] | null>(null);
  const [visits, setVisits] = useState(0);
  const [loadFailure, setLoadFailure] = useState<FailureDescription | null>(
    null,
  );
  const [error, setError] = useState<FailureDescription | null>(null);
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
  function changed() {
    setVisits((value) => value + 1);
    void refresh().catch((reason: unknown) =>
      setError(describeFailure(reason, "refresh the ticket")),
    );
  }
  return {
    found,
    loadFailure,
    error,
    setError,
    changed,
    retry: () => setVisits((value) => value + 1),
  };
}

export type TicketAttachmentsState = ReturnType<typeof useTicketAttachments>;
