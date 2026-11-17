import { useState } from "react";
import { m } from "motion/react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  blur,
  enterTransition,
  rise,
  spring,
  staggerDelay,
} from "@/lib/motion-tokens";
import "./ticket-list.css";

/** The wait before any placeholder shows, so a fast read never flashes one. */
function loadingDelay(): number {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--dur-loading-delay")
    .trim();
  return (Number.parseFloat(value) || 0) / (value.endsWith("ms") ? 1000 : 1);
}

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
  return (
    <div role="status" aria-label="Loading tickets">
      <span className="sr-only">Loading tickets…</span>
      <ul className="ticket-rows" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => {
          const wait = delay + staggerDelay(index);
          return (
            <m.li
              key={index}
              initial={{
                opacity: 0,
                y: rise("row"),
                filter: `blur(${blur("in")}px)`,
              }}
              animate={{
                opacity: 1,
                y: 0,
                filter: "blur(0px)",
                // The delay sits inside each entry: a `default` entry would
                // otherwise start at once and ignore a delay beside it.
                transition: {
                  default: { ...enterTransition(), delay: wait },
                  y: { ...spring("smooth"), delay: wait },
                },
              }}
            >
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
      </ul>
    </div>
  );
}
