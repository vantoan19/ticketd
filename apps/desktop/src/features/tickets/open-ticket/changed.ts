import { createContext, useCallback, useContext } from "react";
import type { Ticket } from "@/lib/api/client";
import { useWrote, type Fill, type Returned } from "@/lib/workspace-reads";

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
 * `changed(returned, fills)`.
 *
 * - `returned` is every Ticket the write returned. They show at once (in the
 *   list too), and a later read of them replaces them.
 * - `fills` is what the write set that no Ticket carries, built by the part of
 *   the page that owns it (`followingFill`, `editedUpdateFills`, the Document
 *   link fills), so a section shows its own write through the cache instead of
 *   keeping a copy. A filled value stays through a failed re-read, and the next
 *   good read replaces it.
 *
 * Then it makes what is on screen current. Never rejects. `changed()` with no
 * arguments reports a write that returned nothing.
 */
export function useTicketChanged(): (
  returned?: ReturnedTickets,
  fills?: readonly Fill[],
) => Promise<void> {
  const wrote = useWrote();
  const sync = useContext(ListSync);
  return useCallback(
    (returned, fills) => {
      for (const ticket of [returned ?? []].flat()) sync(ticket);
      const report: Returned = {
        ...(returned && { ticket: returned }),
        ...(fills && { fills }),
      };
      return wrote(report);
    },
    [wrote, sync],
  );
}
