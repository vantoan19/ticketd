import { useContext, useState } from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { Network, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { SourceLink } from "@/features/tickets/SourceLink";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Duplicates } from "@/features/tickets/Duplicates";
import { LinkTicketDialog } from "@/features/tickets/LinkTicketDialog";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { DuplicateTarget } from "@/lib/api/client";
import { linkLabel, type LinkRow } from "@/features/tickets/linked-work";
import {
  duplicateTargetParts,
  externalDuplicateTarget,
  externalSource,
} from "@/features/tickets/ticket-source";
import { RailSection } from "@/features/tickets/RailSection";
import type { LinkedWorkState } from "@/features/tickets/useLinkedWork";
import "./linked-work.css";
import { Item } from "@/components/ui/item";
import { Reference } from "@/components/ui/reference";

const isDuplicateKind = (kind: LinkRow["kind"]) =>
  kind === "duplicate_of" || kind === "duplicates";

/** The dialogs the relationship actions open; one instance serves the rail and Subtickets. */
export function LinkedWorkDialogs({ work }: { work: LinkedWorkState }) {
  const { ticket, refresh, retry } = work;
  return (
    <>
      <LinkTicketDialog
        ticket={ticket}
        open={work.linking !== null}
        {...(work.linking && { initialKind: work.linking })}
        onOpenChange={(open) => {
          if (!open) work.closeLink();
        }}
        onLinked={async () => {
          retry();
          await refresh();
        }}
      />
      {ticket.duplicate_redirect && work.redirecting && (
        <Duplicates
          ticket={ticket}
          initialCanonical={ticket.duplicate_redirect}
          refresh={async () => {
            retry();
            await refresh();
          }}
          open
          onOpenChange={work.setRedirecting}
          title="Point this duplicate at the original"
          description={`${ticket.duplicate_of} became a duplicate of ${ticket.duplicate_redirect}. Review the dependencies, then mark ${ticket.reference} as a duplicate of ${ticket.duplicate_redirect} instead.`}
        />
      )}
      {work.reviewing && (
        <Duplicates
          ticket={ticket}
          startSeparate
          refresh={async () => {
            retry();
            await refresh();
          }}
          open
          onOpenChange={work.setReviewing}
          title="Review dependency changes"
          description={`Move dependencies between ${ticket.reference} and another ticket after a duplicate link was removed.`}
        />
      )}
    </>
  );
}

/**
 * Every link except subtickets as the rail's Relationships section, grouped by
 * meaning. Subtickets read under the description instead.
 */
export function LinkedWork({
  work,
  select,
  onOpenGraph,
}: {
  work: LinkedWorkState;
  select: (reference: string) => void;
  onOpenGraph: () => void;
}) {
  const { reference, current, pending, error } = work;
  // A trashed ticket keeps its relationships visible (an unresolved blocker still
  // matters) but they cannot be changed.
  const readOnly = work.ticket.trashed;
  const openContextGraph = useContext(ContextGraphNavigation);
  const listed = work.rows.filter((row) => row.kind !== "subticket");
  // Blockers that still hold this ticket back come first within "Blocked by".
  const blockers = listed
    .filter((row) => row.kind === "blocked_by")
    .sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
  let nextBlocker = 0;
  const rows = listed.map((row) =>
    row.kind === "blocked_by" ? blockers[nextBlocker++]! : row,
  );
  // A duplicate closed by its source names a canonical issue that may not be a
  // local ticket; it is information and has no remove action.
  const external = externalDuplicateTarget(work.ticket);
  const externalAt = rows.findIndex((row) => row.kind === "duplicates");
  const linkAction = readOnly ? null : (
    <Button variant="ghost" size="sm" onClick={() => work.openLink()}>
      <Plus aria-hidden="true" />
      Add relationship
    </Button>
  );
  // Collapse to the bare action only after a successful read found nothing;
  // loading and failed look different from "no links".
  if (!current?.links || (rows.length === 0 && !external)) {
    if (readOnly && current?.links) return null;
    return (
      <RailSection label="Relationships">
        <div id={`linked-work-${reference}`} className="linked-work" data-empty>
          {linkAction}
          {current?.links && openContextGraph && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openContextGraph(reference)}
            >
              <Network aria-hidden="true" />
              Open context graph
            </Button>
          )}
          {!current && (
            <span className="linked-work-state" role="status">
              Loading relationships…
            </span>
          )}
          {current && !current.links && current.failure && (
            <FailureState
              size="inline"
              failure={current.failure}
              onRetry={work.retry}
            />
          )}
          {error && <FailureAlert size="compact" failure={error} />}
        </div>
      </RailSection>
    );
  }
  const split = externalAt < 0 ? rows.length : externalAt;
  const renderRow = (row: LinkRow, index: number) => (
    <Item asChild key={`${row.kind}-${row.reference}`}>
      <li data-kind={row.kind}>
        {/* Rows of one kind read as a group: only the first shows its
                  label, and screen readers still hear it on every row. */}
        <span
          className="linked-work-label"
          data-repeat={rows[index - 1]?.kind === row.kind || undefined}
        >
          {linkLabel(row.kind)}
        </span>
        <span
          className="linked-work-icon"
          role="img"
          aria-label={statusText(row)}
        >
          <StatusIcon status={row.status} size={16} decorative />
        </span>
        <Reference>{row.reference}</Reference>
        <Button
          variant="link"
          className="linked-work-title"
          title={row.title}
          onClick={() => select(row.reference)}
        >
          <span className="truncate">{row.title}</span>
        </Button>
        <span
          className="linked-work-status"
          aria-hidden="true"
          data-qualified={
            (row.kind === "blocked_by" && row.unresolved) ||
            row.trashed ||
            undefined
          }
        >
          {statusText(row)}
        </span>
        {readOnly ? null : isDuplicateKind(row.kind) &&
          !externalSource(work.ticket)?.status_locked ? (
          <RemoveDuplicate
            row={row}
            ticket={reference}
            disabled={pending}
            onRemove={() => void work.remove(row)}
            onReview={() => work.setReviewing(true)}
          />
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            className="linked-work-remove"
            title="Remove relationship"
            aria-label={`Remove relationship: ${linkLabel(row.kind)} ${row.reference}`}
            disabled={pending}
            onClick={() => void work.remove(row)}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </li>
    </Item>
  );
  return (
    <RailSection label="Relationships">
      <div id={`linked-work-${reference}`} className="linked-work">
        {error && <FailureAlert size="compact" failure={error} />}
        {current.failure && (
          <FailureState
            size="inline"
            failure={current.failure}
            onRetry={work.retry}
          />
        )}
        <ul className="linked-work-rows">
          {rows.slice(0, split).map((row, index) => renderRow(row, index))}
          {external && <ExternalTargetRow target={external} select={select} />}
          {rows.slice(split).map((row, index) => renderRow(row, split + index))}
        </ul>
        {work.ticket.duplicate_redirect && (
          <p className="linked-work-note">
            {work.ticket.duplicate_of} is itself a duplicate of{" "}
            {work.ticket.duplicate_redirect}.{" "}
            <Button
              variant="link"
              size="xs"
              onClick={() => work.setRedirecting(true)}
            >
              Point this at {work.ticket.duplicate_redirect}
            </Button>
          </p>
        )}
        {work.more !== null && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void work.showMore()}
          >
            Show more links
          </Button>
        )}
        <div className="linked-work-actions">
          {linkAction}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              openContextGraph ? openContextGraph(reference) : onOpenGraph()
            }
          >
            <Network aria-hidden="true" />
            {openContextGraph ? "Open context graph" : "Dependencies"}
          </Button>
        </div>
      </div>
    </RailSection>
  );
}

/** The canonical issue a source named for a duplicate, without pretending it is a local ticket. */
function ExternalTargetRow({
  target,
  select,
}: {
  target: DuplicateTarget;
  select: (reference: string) => void;
}) {
  const { label, ticket, note, url } = duplicateTargetParts(target);
  return (
    <Item asChild>
      <li data-kind="duplicate_of" data-external>
        <span className="linked-work-label">{linkLabel("duplicate_of")}</span>
        <span className="linked-work-external">
          {ticket ? (
            <Button
              variant="link"
              className="linked-work-title"
              onClick={() => select(ticket)}
            >
              {label}
            </Button>
          ) : url ? (
            <SourceLink url={url}>{label}</SourceLink>
          ) : // A reference is monospace; "Unknown" is a word.
          target.kind === "unknown" ? (
            <span>{label}</span>
          ) : (
            <Reference>{label}</Reference>
          )}{" "}
          <span className="linked-work-note">{note}</span>
        </span>
      </li>
    </Item>
  );
}

/**
 * Removing a duplicate link is not a plain delete: it restores the duplicate's
 * earlier status and leaves moved dependencies where they are. The person sees
 * that before confirming.
 */
function RemoveDuplicate({
  row,
  ticket,
  disabled,
  onRemove,
  onReview,
}: {
  row: LinkRow;
  ticket: string;
  disabled: boolean;
  onRemove: () => void;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const duplicate = row.kind === "duplicate_of" ? ticket : row.reference;
  const canonical = row.kind === "duplicate_of" ? row.reference : ticket;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="linked-work-remove"
          title="Remove relationship"
          aria-label={`Remove relationship: ${linkLabel(row.kind)} ${row.reference}`}
          disabled={disabled}
        >
          <X aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Remove duplicate link"
        className="linked-work-confirm"
      >
        <p>
          {duplicate} stops being a duplicate of {canonical} and returns to the
          status it had before. Dependencies that were moved to {canonical} stay
          where they are; review them separately.
        </p>
        <div className="linked-work-confirm-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false);
              onReview();
            }}
          >
            Review separate dependency changes
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            Remove duplicate link
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function statusText(row: LinkRow) {
  const parts = [row.status];
  if (row.kind === "blocked_by" && row.unresolved) parts.push("not done");
  if (row.trashed) parts.push("in trash");
  return parts.join(" · ");
}
