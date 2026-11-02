import type { StatusCounts, Ticket } from "@/lib/api/client";
import { statusCountKey, workflowStatuses } from "@/lib/statuses";

export type TicketGroup = {
  status: string;
  /** Tickets of this status in the whole filtered result. */
  count: number;
  /** The part of the group on the page being shown. */
  tickets: Ticket[];
};

/**
 * Buckets the shown page by status. The count is the core's count of the whole
 * result, never the page length; it can only trail the rows by one refresh, so
 * a row is never counted as fewer than the rows shown. Empty groups are
 * omitted.
 */
export function groupTickets(
  tickets: Ticket[],
  counts: StatusCounts,
): TicketGroup[] {
  return workflowStatuses
    .map((status) => {
      const shown = tickets.filter((ticket) => ticket.status === status);
      return {
        status,
        count: Math.max(counts[statusCountKey[status]], shown.length),
        tickets: shown,
      };
    })
    .filter((group) => group.count > 0 && group.tickets.length > 0);
}
