import { createContext, useContext } from "react";
import type { Ticket } from "@/lib/api/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { skip, ticketRead, useRead, withCurrent } from "@/lib/workspace-reads";
import type { ReturnedTickets } from "./changed";
import { usePart, type PartArgs, type PartName, type PartState } from "./parts";

export type OpenTicketState = {
  reference: string;
  record: Ticket;
  /** A saved copy is shown while the first read of the record is unanswered. */
  opening: boolean;
  /**
   * Whether the record is as current as the last change. It is read when asked
   * for, so a page that never asks does not re-render when it moves.
   */
  readonly current: boolean;
  /** The last failure to refresh the record, kept while the page shows it. */
  failure: FailureDescription | null;
  retry(): void;
  /** Reports a write of this Ticket (or others) that succeeded. */
  changed(returned?: ReturnedTickets): Promise<void>;
};

/** What the gate provides; `current` is read by the consumer that asks for it. */
export type OpenTicketScope = Omit<OpenTicketState, "current">;

export const OpenTicketContext = createContext<OpenTicketScope | null>(null);

/**
 * The open Ticket of the enclosing `<OpenTicket>`. `useOpenTicket(part,
 * ...args)` gives a section its data instead (linked work, evidence, ...).
 */
export function useOpenTicket(): OpenTicketState;
export function useOpenTicket<Name extends PartName>(
  part: Name,
  ...args: PartArgs<Name>
): PartState<Name>;
export function useOpenTicket<Name extends PartName>(
  part?: Name,
  ...args: PartArgs<Name>
): OpenTicketState | PartState<Name> | undefined {
  const open = useContext(OpenTicketContext);
  if (!open) throw new Error("useOpenTicket must be used inside <OpenTicket>.");
  // The record's read is shared with the gate; only a caller of the record
  // itself needs to know whether it is current.
  const state = useRead(ticketRead, part === undefined ? open.reference : skip);
  const served = usePart(open.record, part, args);
  if (part !== undefined) return served;
  return withCurrent(open, () => state.current);
}
