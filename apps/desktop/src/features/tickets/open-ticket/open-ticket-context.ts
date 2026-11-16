import { createContext, useContext } from "react";
import type { Ticket } from "@/lib/api/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import type { ReturnedTickets } from "./changed";
import { usePart, type PartArgs, type PartName, type PartState } from "./parts";

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

export const OpenTicketContext = createContext<OpenTicketState | null>(null);

/**
 * The open Ticket of the enclosing `<OpenTicket>`. `useOpenTicket(part,
 * ...args)` gives a section its data instead (linked work, evidence, ...).
 */
export function useOpenTicket(): OpenTicketState;
export function useOpenTicket<Name extends PartName>(
  part: Name,
  ...args: PartArgs<Name>
): PartState<Name>;
export function useOpenTicket(part?: PartName, ...args: unknown[]): unknown {
  const open = useContext(OpenTicketContext);
  if (!open) throw new Error("useOpenTicket must be used inside <OpenTicket>.");
  const served = usePart(open.record, part, args);
  return part ? served : open;
}
