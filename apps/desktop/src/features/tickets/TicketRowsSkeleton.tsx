import { Skeleton } from "@/components/ui/skeleton";
import "./ticket-list.css";

/** Row-shaped placeholders in the final two-line geometry. */
export function TicketRowsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading tickets">
      <span className="sr-only">Loading tickets…</span>
      <ul className="ticket-rows" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <li key={index}>
            <span className="ticket-select" />
            <span className="ticket-row">
              <Skeleton className="ticket-skeleton-icon" />
              <Skeleton className="ticket-skeleton-ref" />
              <Skeleton
                className="ticket-skeleton-title"
                style={{ width: `${55 + ((index * 17) % 35)}%` }}
              />
              <Skeleton className="ticket-skeleton-meta" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
