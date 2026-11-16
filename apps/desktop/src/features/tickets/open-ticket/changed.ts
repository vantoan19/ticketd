import { createContext, useCallback, useContext } from "react";
import type { Ticket } from "@/lib/api/client";
import { useWrote } from "@/lib/workspace-reads";

/** What a write returned: one Ticket, several, or nothing. */
export type ReturnedTickets = Ticket | readonly Ticket[] | null | undefined;

/**
 * Told of each Ticket a write returned, so the Ticket list shows it at once
 * (it is not on the reads module yet). The workspace provides it.
 */
const ListSync = createContext<(ticket: Ticket) => void>(() => {});
export const TicketListSync = ListSync.Provider;

/**
 * The write report for Ticket writes, called once after the write succeeded:
 * it shows the returned Tickets at once and makes what is on screen current.
 * Never rejects.
 */
export function useTicketChanged(): (
  returned?: ReturnedTickets,
) => Promise<void> {
  const wrote = useWrote();
  const sync = useContext(ListSync);
  return useCallback(
    (returned) => {
      for (const ticket of [returned ?? []].flat()) sync(ticket);
      return wrote(returned ? { ticket: returned } : {});
    },
    [wrote, sync],
  );
}
