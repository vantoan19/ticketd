import { useState } from "react";
import { m } from "motion/react";
import { Skeleton } from "@/components/ui/skeleton";
import { Presence } from "@/components/ui/motion";
import { arrival, rowTokens } from "@/components/ui/row-motion";
import { loadingDelay } from "@/lib/motion-tokens";
import "./ticket-list.css";

/**
 * Row-shaped placeholders retain the chosen ledger density. After the loading
 * delay they fade up from a soft blur, a short step apart (DESIGN.md
 * section 12); the sheen on each placeholder is the Skeleton's own.
 */
export function TicketRowsSkeleton({
  count = 6,
  detailed = false,
}: {
  count?: number;
  detailed?: boolean;
}) {
  const [delay] = useState(loadingDelay);
  const tokens = rowTokens();
  return (
    <div role="status" aria-label="Loading tickets">
      <span className="sr-only">Loading tickets…</span>
      <ul className="ticket-rows" aria-hidden="true">
        {/* The pane's own Presence says `initial={false}` for whatever mounts
            with it, which would show these rows at once, past the wait. This
            one lets them fade up. */}
        <Presence initial>
          {Array.from({ length: count }, (_, index) => {
            return (
              // Placeholders never carry data-arrive: they are not page rows.
              <m.li key={index} {...arrival(index, { after: delay }, tokens)}>
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
              </m.li>
            );
          })}
        </Presence>
      </ul>
    </div>
  );
}
