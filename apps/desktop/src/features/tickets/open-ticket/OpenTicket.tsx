import { useMemo, useState, type ReactNode } from "react";
import { FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { Ticket } from "@/lib/api/client";
import { ticketRead, useRead, Visibility } from "@/lib/workspace-reads";
import { useTicketChanged } from "./changed";
import { OpenTicketContext, type OpenTicketScope } from "./open-ticket-context";

/**
 * A scope and a gate for one Ticket that is open: its children render once a
 * record is known, either read or the `seed` (a copy the list already holds).
 * Before that it shows the page skeleton, and after a failed first read the
 * failure with Retry. A hidden Open Ticket makes no reads.
 */
export function OpenTicket({
  reference,
  seed,
  hidden = false,
  children,
}: {
  reference: string;
  seed?: Ticket | undefined;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <Visibility hidden={hidden}>
      <Gate reference={reference} seed={seed} hidden={hidden}>
        {children}
      </Gate>
    </Visibility>
  );
}

function Gate({
  reference,
  seed,
  hidden,
  children,
}: {
  reference: string;
  seed: Ticket | undefined;
  hidden: boolean;
  children: ReactNode;
}) {
  const state = useRead(ticketRead, reference);
  const changed = useTicketChanged();
  // The latest copy the list offered is kept, so deselecting while the first
  // read is unanswered does not close the page.
  const [kept, setKept] = useState(seed);
  if (seed && seed !== kept) setKept(seed);
  const record = state.value ?? kept;
  const opening = state.value === undefined;
  const { failure, retry } = state;
  const open = useMemo<OpenTicketScope | null>(
    () =>
      record ? { reference, record, opening, failure, retry, changed } : null,
    [reference, record, opening, failure, retry, changed],
  );
  // A Ticket that was read and is now gone is a failure too, not its old copy.
  const gone = failure?.code === "not_found";
  if ((state.status === "failed" || gone) && failure)
    return hidden ? null : <FailureState failure={failure} onRetry={retry} />;
  if (!open) {
    if (hidden) return null;
    return (
      <div
        className="detail-document"
        role="status"
        aria-label="Loading ticket"
      >
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="mt-3 h-7 w-full" />
        <Skeleton className="mt-8 h-11 w-full" />
        <Skeleton className="mt-6 h-24 w-full" />
      </div>
    );
  }
  return (
    <OpenTicketContext.Provider value={open}>
      {!hidden && opening && (
        <span className="sr-only" role="status">
          Loading the latest ticket. Showing its saved copy.
        </span>
      )}
      {children}
    </OpenTicketContext.Provider>
  );
}
