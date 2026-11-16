import type { ReactNode } from "react";
import type { Ticket } from "@/lib/api/client";
import type { ChangeSignal } from "@/lib/workspace-reads";
import { TestOpenTicket } from "../testing";

/** A minimal Ticket with this reference, for tests of Activity and the agent line. */
export function ticketFor(
  reference: string,
  overrides: Partial<Ticket> = {},
): Ticket {
  return {
    id: `id-${reference}`,
    reference,
    title: "Ticket",
    status: "Todo",
    trashed: false,
    body: "",
    project_id: null,
    plan_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
    ...overrides,
  };
}

/**
 * Renders `children` as a section of the open Ticket `reference`. Keep one
 * `signal` (from `fakeChangeSignal`) to move the change from the test, and
 * `hidden` to hide the page.
 */
export function OpenTicketFor({
  reference,
  signal,
  hidden,
  ticket,
  children,
}: {
  reference: string;
  signal?: ChangeSignal;
  hidden?: boolean;
  ticket?: Partial<Ticket>;
  children: ReactNode;
}) {
  return (
    <TestOpenTicket
      ticket={ticketFor(reference, ticket)}
      {...(signal && { signal })}
      {...(hidden !== undefined && { hidden })}
    >
      {children}
    </TestOpenTicket>
  );
}
