import { forwardRef } from "react";
import { cn } from "cn";
import type { LucideIcon, LucideProps } from "lucide-react";
import type { TicketStatus } from "@/lib/statuses";
import "./status-glyph.css";

/** Shared by current status and recorded changes; these are not Lucide drawings. */
function glyph(status: string): LucideIcon {
  const Glyph = forwardRef<SVGSVGElement, LucideProps>(function Glyph(
    { size = 16, className, ...props },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        className={cn("status-glyph", className)}
        data-status={status}
        fill="none"
        {...props}
      >
        {status === "Done" ? (
          <>
            <circle
              className="status-glyph-disc"
              cx="8"
              cy="8"
              r="7"
              fill="currentColor"
            />
            <path
              className="status-glyph-check"
              d="M5.4 8.2 7.1 9.9 10.6 6.3"
              pathLength="1"
              stroke="var(--surface)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            {(status === "In progress" || status === "In review") && (
              <circle
                className="status-glyph-sweep-disc"
                cx="8"
                cy="8"
                r="3.75"
                fill="currentColor"
              />
            )}
            {status === "In progress" && (
              <path
                className="status-glyph-pie"
                fill="currentColor"
                d="M8 4.25a3.75 3.75 0 0 1 0 7.5z"
              />
            )}
            {status === "In review" && (
              <path
                className="status-glyph-pie"
                fill="currentColor"
                d="M8 4.25a3.75 3.75 0 1 1-3.75 3.75H8z"
              />
            )}
            {status === "Canceled" && (
              <path
                d="M5.6 10.4 10.4 5.6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            )}
            {status === "Duplicate" && (
              <path
                d="M5.75 6.9h4.5M5.75 9.1h4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            )}
          </>
        )}
      </svg>
    );
  });
  Glyph.displayName = `${status}Glyph`;
  return Glyph;
}

/** The glyph of a status; Canceled and Duplicate never share Done’s. */
export const statusIcons: Record<TicketStatus, LucideIcon> &
  Record<string, LucideIcon> = {
  Todo: glyph("Todo"),
  "In progress": glyph("In progress"),
  "In review": glyph("In review"),
  Done: glyph("Done"),
  Canceled: glyph("Canceled"),
  Duplicate: glyph("Duplicate"),
};
