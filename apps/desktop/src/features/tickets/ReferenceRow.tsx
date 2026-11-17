import { m } from "motion/react";
import { arrival, departure, glide } from "@/components/ui/row-motion";
import type { ReactNode } from "react";
import { Reference } from "@/components/ui/reference";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusIcon } from "./StatusIcon";

/**
 * A linked ticket (P12 ReferenceRow), built for Subtickets and the rail's
 * Relationships. The whole row opens the ticket.
 *
 * - `list` (the reading column): one 36px line, [status icon] [reference]
 *   [title, cut with a tooltip] [caption] [action].
 * - `rail`: two lines in the rail's width: [status icon] [reference]
 *   [caption] [action] over the title, clamped to two lines, so a row is
 *   never more than three lines tall.
 *
 * `action` (a remove IconButton) sits in a reserved slot, revealed on hover
 * and focus, always visible on touch.
 */
export function ReferenceRow({
  reference,
  title,
  status,
  caption,
  statusLabel,
  density,
  onOpen,
  action,
  kind,
  animated = false,
  layoutDependency,
}: {
  reference: string;
  title: string;
  status: string;
  /** The trailing 12px words: the status, "not done", "in Trash". */
  caption: string;
  /** The status icon's accessible name, when it says more than the status. */
  statusLabel?: string;
  density: "list" | "rail";
  onOpen: () => void;
  action?: ReactNode;
  /** The relationship the row stands for, for styling and tests. */
  kind?: string;
  /** Fades up when it arrives, fades out when it leaves and glides when a
   *  neighbour does; the list puts its rows in a `Presence`. */
  animated?: boolean;
  /** Changes when the list's order does, so the row is measured then only. */
  layoutDependency?: string;
}) {
  return (
    <m.li
      className="reference-row"
      {...(animated && {
        ...arrival(),
        ...departure(),
        ...glide(layoutDependency),
      })}
      data-density={density}
      data-kind={kind}
      data-action={action ? "" : undefined}
    >
      <span
        className="reference-row-icon"
        role="img"
        aria-label={statusLabel ?? status}
      >
        <StatusIcon status={status} size={16} decorative />
      </span>
      <Reference>{reference}</Reference>
      <Tooltip content={title} overflowOnly side="top">
        <button type="button" className="reference-row-title" onClick={onOpen}>
          {title}
        </button>
      </Tooltip>
      <span className="reference-row-caption" aria-hidden="true">
        {caption}
      </span>
      {action && <span className="reference-row-action">{action}</span>}
    </m.li>
  );
}
