import { useId } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { LinkedWorkState } from "@/features/tickets/useLinkedWork";
import "./subtickets.css";

/**
 * The ticket's subtickets directly under its description, with local progress.
 * With none, only the Add subticket action shows.
 */
export function Subtickets({
  work,
  select,
}: {
  work: LinkedWorkState;
  select: (reference: string) => void;
}) {
  const headingId = useId();
  const rows = work.rows.filter((row) => row.kind === "subticket");
  const links = work.current?.links;
  if (!links) return null;
  const add = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => work.openLink("subticket")}
    >
      <Plus aria-hidden="true" />
      Add subticket
    </Button>
  );
  if (rows.length === 0)
    return (
      <div className="subtickets" data-empty>
        {add}
      </div>
    );
  const done = rows.filter((row) => row.status === "Done").length;
  // More subtickets than were read: the total is a lower bound.
  const partial = links.children.next_offset !== null;
  const summary = `${done} of ${rows.length}${partial ? "+" : ""} done`;
  return (
    <section className="subtickets" aria-labelledby={headingId}>
      <div className="detail-section-heading">
        <h3 id={headingId}>Subtickets</h3>
        <progress
          className="subtickets-progress"
          aria-label="Subticket progress"
          value={done}
          max={rows.length}
        />
        <span className="subtickets-summary">{summary}</span>
        {add}
      </div>
      <ul className="subtickets-rows">
        {rows.map((row) => (
          <li key={row.reference} className="subtickets-row">
            <StatusIcon status={row.status} size={14} decorative />
            <span className="subtickets-reference">{row.reference}</span>
            <Button
              variant="link"
              className="subtickets-title"
              onClick={() => select(row.reference)}
            >
              {row.title}
            </Button>
            <span className="subtickets-status">
              {row.trashed ? `${row.status} · in trash` : row.status}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="subtickets-remove"
              title="Remove relationship"
              aria-label={`Remove relationship: Subtickets ${row.reference}`}
              disabled={work.pending}
              onClick={() => void work.remove(row)}
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {partial && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void work.showMore()}
        >
          Show more subtickets
        </Button>
      )}
    </section>
  );
}
