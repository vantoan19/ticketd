import { Skeleton } from "@/components/ui/skeleton";
import "./ticket-list.css";

/** Row-shaped placeholders retain the chosen ledger density. */
export function TicketRowsSkeleton({
  count = 6,
  detailed = false,
}: {
  count?: number;
  detailed?: boolean;
}) {
  return (
    <div role="status" aria-label="Loading tickets">
      <span className="sr-only">Loading tickets…</span>
      <ul className="ticket-rows" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <li key={index}>
            <span className="ticket-select" />
            <span
              className="ticket-row"
              data-rows={detailed ? "detailed" : "simple"}
            >
              <span className="ticket-skeleton-icon">
                <Skeleton className="size-full" />
              </span>
              <Skeleton className="h-3 w-11 self-center" />
              <Skeleton
                className="h-3.5 self-center"
                style={{ width: `${55 + ((index * 17) % 35)}%` }}
              />
              {detailed && (
                <span className="ticket-row-update">
                  <Skeleton className="h-2.5 w-24" />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
