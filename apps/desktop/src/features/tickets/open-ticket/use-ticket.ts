import type { Ticket } from "@/lib/api/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { skip, ticketRead, useRead, withCurrent } from "@/lib/workspace-reads";
import { usePart, type PartArgs, type PartName, type PartState } from "./parts";

export type TicketState = {
  /** The Ticket; null when it no longer exists; undefined until it is known. */
  value: Ticket | null | undefined;
  failure: FailureDescription | null;
  retry(): void;
  /** Whether `value` is as current as the last change. */
  readonly current: boolean;
};

/**
 * One Ticket by reference, for chips and the header outside a page. Every
 * caller naming the same Ticket shares one read; with no reference it reads
 * nothing. `useTicket(reference, part, ...args)` serves a part of the Ticket.
 */
export function useTicket(reference: string | null): TicketState;
export function useTicket<Name extends PartName>(
  reference: string | null,
  part: Name,
  ...args: PartArgs<Name>
): PartState<Name>;
export function useTicket<Name extends PartName>(
  reference: string | null,
  part?: Name,
  ...args: PartArgs<Name>
): TicketState | PartState<Name> | undefined {
  const state = useRead(ticketRead, reference ?? skip);
  // A failed re-read keeps the last copy, but "not found" says it is gone.
  const gone = state.failure?.code === "not_found";
  const served = usePart(gone ? undefined : state.value, part, args);
  if (part !== undefined) return served;
  return withCurrent(
    {
      value: gone ? null : state.value,
      failure: state.failure,
      retry: state.retry,
    },
    () => state.current,
  );
}
