import { useState } from "react";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { useOpenTicket } from "./open-ticket";

/**
 * The files attached directly to a ticket, read through the Open Ticket: they
 * are read again when the workspace changes or after a write reported here,
 * and not when the window comes back.
 */
export function useTicketAttachments() {
  const { changed: report } = useOpenTicket();
  const read = useOpenTicket("attachments");
  const [error, setError] = useState<FailureDescription | null>(null);
  return {
    // Undefined until the first read answers: an unread section never claims
    // "no files".
    found: read.value ?? null,
    loadFailure: read.failure,
    error,
    setError,
    /** Reports that a file was attached, detached or replaced. */
    changed: () => void report(),
    retry: read.retry,
  };
}

export type TicketAttachmentsState = ReturnType<typeof useTicketAttachments>;
