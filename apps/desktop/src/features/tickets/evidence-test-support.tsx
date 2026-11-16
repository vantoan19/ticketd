import type { Ticket } from "@/lib/api/client";
import { TestOpenTicket } from "@/features/tickets/open-ticket/testing";
import { Evidence } from "./Evidence";

/** A Ticket with this reference, for tests of sections inside an Open Ticket. */
const ticketNamed = (reference: string): Ticket => ({
  id: reference,
  reference,
  title: "Work",
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
});

/** The Evidence section of the Ticket `reference`, inside a fresh Open Ticket. */
export function OpenEvidence({
  reference,
  ...props
}: { reference: string } & Omit<Parameters<typeof Evidence>[0], "trashed"> & {
    trashed?: boolean;
  }) {
  return (
    <TestOpenTicket ticket={ticketNamed(reference)}>
      <Evidence trashed={false} {...props} />
    </TestOpenTicket>
  );
}
