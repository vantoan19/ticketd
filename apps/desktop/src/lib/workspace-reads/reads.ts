import { client } from "@/lib/api/client";
import { read } from "./catalog";

// The catalogue: reads that more than one part of the desktop shares, declared
// once. A view uses them through a domain module, never by naming the client.

/** One Ticket by reference. A Ticket returned by a write fills it. */
export const ticketRead = read({
  key: "ticket",
  call: (reference: string) => client.showTicket(reference),
  failure: (reference) => `load ${reference}`,
  seededBy: { ticket: (value) => ({ args: value.reference, value }) },
});
