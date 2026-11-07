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
              <span className="ticket-skeleton-icon">
                <Skeleton className="size-full" />
              </span>
              <Skeleton className="h-3 w-9 self-center" />
              <Skeleton
                className="h-3.5 self-center"
                style={{ width: `${55 + ((index * 17) % 35)}%` }}
              />
              <Skeleton className="col-start-3 my-0.75 h-2.5 w-24 self-center" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
