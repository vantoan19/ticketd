import type { StatusCounts, Ticket } from "@/lib/api/client";

/** Groups appear in workflow order; the core pages through the same order. */
export const groupStatuses = [
  "In progress",
  "In review",
  "Todo",
  "Done",
  "Canceled",
  "Duplicate",
] as const;

export type TicketGroup = {
  status: string;
  /** Tickets of this status in the whole filtered result. */
  count: number;
  /** The part of the group on the page being shown. */
  tickets: Ticket[];
};

function countFor(counts: StatusCounts, status: string): number {
  switch (status) {
    case "In progress":
      return counts.in_progress;
    case "In review":
      return counts.in_review;
    case "Todo":
      return counts.todo;
    case "Done":
      return counts.done;
    case "Canceled":
      return counts.canceled;
    default:
      return counts.duplicate;
  }
}

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
  return groupStatuses
    .map((status) => {
      const shown = tickets.filter((ticket) => ticket.status === status);
      return {
        status,
        count: Math.max(countFor(counts, status), shown.length),
        tickets: shown,
      };
    })
    .filter((group) => group.count > 0 && group.tickets.length > 0);
}
