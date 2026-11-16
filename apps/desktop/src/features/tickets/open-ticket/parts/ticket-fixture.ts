import type { Ticket } from "@/lib/api/client";

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
