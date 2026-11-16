import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { Ticket } from "@/lib/api/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { ticketRead, useRead, Visibility } from "@/lib/workspace-reads";
import { useTicketChanged, type ReturnedTickets } from "./changed";

export type OpenTicketState = {
  reference: string;
  record: Ticket;
  /** A saved copy is shown while the first read of the record is unanswered. */
  opening: boolean;
  /** Whether the record is as current as the last change. */
  current: boolean;
  /** The last failure to refresh the record, kept while the page shows it. */
  failure: FailureDescription | null;
  retry(): void;
  /** Reports a write of this Ticket (or others) that succeeded. */
  changed(returned?: ReturnedTickets): Promise<void>;
};

const OpenTicketContext = createContext<OpenTicketState | null>(null);

/** The open Ticket of the enclosing `<OpenTicket>`. */
export function useOpenTicket(): OpenTicketState {
  const open = useContext(OpenTicketContext);
  if (!open) throw new Error("useOpenTicket must be used inside <OpenTicket>.");
  return open;
}

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
  const current = state.current;
  const open = useMemo<OpenTicketState | null>(
    () =>
      record
        ? { reference, record, opening, current, failure, retry, changed }
        : null,
    [reference, record, opening, current, failure, retry, changed],
  );
  if (state.status === "failed" && failure)
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
