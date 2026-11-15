import { SectionHeader } from "@/components/ui/section-header";
import { useId } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Pager } from "@/components/ui/pager";
import type { LinkedWorkState } from "@/features/tickets/useLinkedWork";
import { ReferenceRow } from "./ReferenceRow";
import "./linked-work.css";
import "./subtickets.css";
import { Progress } from "@/components/ui/progress";

/**
 * The ticket's subtickets directly under its description, with local progress,
 * as one-line ReferenceRows. With none, only the Add subticket action shows;
 * a ticket in Trash shows its subtickets read-only, and nothing without any.
 */
export function Subtickets({
  work,
  select,
  external = false,
}: {
  external?: boolean;
  work: LinkedWorkState;
  select: (reference: string) => void;
}) {
  const headingId = useId();
  const rows = work.rows.filter((row) => row.kind === "subticket");
  const links = work.current?.links;
  const readOnly = work.ticket.trashed;
  if (!links) return null;
  // Progress comes from the core over every subticket, not the page read.
  const { done, total } = links.children_progress;
  if (readOnly && total === 0) return null;
  const add = !readOnly && (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => work.openLink("subticket")}
    >
      <Plus aria-hidden="true" />
      Add subticket
    </Button>
  );
  const partial = links.children.next_offset !== null;
  const summary = `${done} of ${total} done`;
  // A failed removal shows here, where it was asked for.
  const error = work.error?.kind === "subticket" ? work.error.failure : null;
  return (
    <section className="subtickets" aria-labelledby={headingId}>
      <SectionHeader
        title="Subtickets"
        titleId={headingId}
        {...(add && { actions: add })}
      >
        {total > 0 && (
          <>
            <Progress
              aria-label="Subticket progress"
              value={done}
              max={total}
            />
            <span className="subtickets-summary">{summary}</span>
          </>
        )}
      </SectionHeader>
      {external && (
        <p className="source-caption">
          Subtickets are local. Publishing never includes them.
        </p>
      )}
      <ul className="reference-rows">
        {rows.map((row) => (
          <ReferenceRow
            key={row.reference}
            kind="subticket"
            density="list"
            reference={row.reference}
            title={row.title}
            status={row.status}
            caption={row.trashed ? `${row.status} · in Trash` : row.status}
            onOpen={() => select(row.reference)}
            action={
              readOnly ? undefined : (
                <IconButton
                  size="icon-xs"
                  label={`Remove ${row.reference} as subticket`}
                  tooltipSide="top"
                  disabled={work.pending}
                  onClick={() => void work.remove(row)}
                >
                  <X aria-hidden="true" />
                </IconButton>
              )
            }
          />
        ))}
      </ul>
      {error && <FailureAlert size="compact" failure={error} />}
      {partial && (
        <Pager noun="subtickets" onMore={() => void work.showMore()} />
      )}
    </section>
  );
}
