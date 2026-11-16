import { SectionHeader } from "@/components/ui/section-header";
import { useId } from "react";
import { MoreHorizontal, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  grouped = false,
}: {
  external?: boolean;
  grouped?: boolean;
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
    <IconButton
      label="Add subticket"
      tooltipSide="top"
      onClick={() => work.openLink("subticket")}
    >
      <Plus aria-hidden="true" />
    </IconButton>
  );
  const partial = links.children.next_offset !== null;
  const summary = `${done} of ${total} done`;
  // A failed removal shows here, where it was asked for.
  const error = work.error?.kind === "subticket" ? work.error.failure : null;
  return (
    <section
      className={grouped ? "linked-work-subtickets" : "subtickets"}
      aria-labelledby={headingId}
    >
      {grouped ? (
        <div className="linked-work-group">
          <span id={headingId}>Subtickets</span>
          {add}
        </div>
      ) : (
        <SectionHeader
          title="Subtickets"
          count={total || undefined}
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
      )}
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
            caption={[
              row.status,
              row.trashed && "in Trash",
              grouped &&
                work.rows.some(
                  (link) =>
                    link.kind === "blocked_by" &&
                    link.reference === row.reference,
                ) &&
                "blocks this",
            ]
              .filter(Boolean)
              .join(" · ")}
            onOpen={() => select(row.reference)}
            action={
              readOnly ? undefined : grouped &&
                work.rows.some(
                  (link) =>
                    link.kind === "blocked_by" &&
                    link.reference === row.reference,
                ) ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      size="icon-xs"
                      label={`Actions for linked ${row.reference}`}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        disabled={work.pending}
                        onSelect={() => void work.remove(row)}
                      >
                        Remove subticket
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={work.pending}
                        onSelect={() => {
                          const blocker = work.rows.find(
                            (link) =>
                              link.kind === "blocked_by" &&
                              link.reference === row.reference,
                          );
                          if (blocker) void work.remove(blocker);
                        }}
                      >
                        Remove blocker
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
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
