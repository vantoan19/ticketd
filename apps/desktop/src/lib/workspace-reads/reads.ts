import { client, type Ticket } from "@/lib/api/client";
import { toFailure } from "@/lib/api/bridge-failure";
import { read } from "./catalog";

// The catalogue: reads that more than one part of the desktop shares, declared
// once. A view uses them through a domain module, never by naming the client.

/**
 * One Ticket by reference; null when the core says it does not exist. "Gone" is
 * an answer, not a failure, so it is cached and shared like a Ticket: a later
 * read that fails another way keeps it. A Ticket returned by a write fills it.
 */
export const ticketRead = read({
  key: "ticket",
  call: async (reference: string): Promise<Ticket | null> => {
    try {
      return await client.showTicket(reference);
    } catch (reason) {
      if (toFailure(reason).code === "not_found") return null;
      throw reason;
    }
  },
  failure: (reference) => `load ${reference}`,
  seededBy: { ticket: (value) => ({ args: value.reference, value }) },
});
