import { useId } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { LinkedWorkState } from "@/features/tickets/useLinkedWork";
import "./subtickets.css";

/**
 * The ticket's subtickets directly under its description, with local progress.
 * With none, only the Link subticket action shows.
 */
export function Subtickets({
  work,
  select,
  external = false,
  quiet = false,
}: {
  external?: boolean;
  /** With no subtickets, show nothing; the page offers Link subticket in a shared row. */
  quiet?: boolean;
  work: LinkedWorkState;
  select: (reference: string) => void;
}) {
  const headingId = useId();
  const rows = work.rows.filter((row) => row.kind === "subticket");
  const links = work.current?.links;
  if (!links) return null;
  if (quiet && links.children_progress.total === 0 && rows.length === 0)
    return null;
  const add = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => work.openLink("subticket")}
    >
      <Plus aria-hidden="true" />
      Link subticket
    </Button>
  );
  // Progress comes from the core over every subticket, not the page read.
  const { done, total } = links.children_progress;
  const partial = links.children.next_offset !== null;
  const summary = `${done} of ${total} done`;
  return (
    <section className="subtickets" aria-labelledby={headingId}>
      <div className="detail-section-heading">
        <h3 id={headingId}>Subtickets</h3>
        {total > 0 && (
          <>
            <progress
              className="subtickets-progress"
              aria-label="Subticket progress"
              value={done}
              max={total}
            />
            <span className="subtickets-summary">{summary}</span>
          </>
        )}
        {add}
      </div>
      {external && (
        <p className="source-caption">
          Subtickets are local. Publishing never includes them.
        </p>
      )}
      <ul className="subtickets-rows">
        {rows.map((row) => (
          <li key={row.reference} className="subtickets-row">
            <StatusIcon status={row.status} size={16} decorative />
            <span className="subtickets-reference">{row.reference}</span>
            <Button
              variant="link"
              className="subtickets-title"
              onClick={() => select(row.reference)}
            >
              <span className="truncate">{row.title}</span>
            </Button>
            <span className="subtickets-status">
              {row.trashed ? `${row.status} · in trash` : row.status}
            </span>
            <IconButton
              size="icon-xs"
              className="subtickets-remove"
              label={`Remove relationship: Subtickets ${row.reference}`}
              disabled={work.pending}
              onClick={() => void work.remove(row)}
            >
              <X aria-hidden="true" />
            </IconButton>
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
