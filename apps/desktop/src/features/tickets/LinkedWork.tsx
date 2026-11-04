import { useState } from "react";
import { Network, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SourceLink } from "@/features/tickets/SourceLink";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
      {ticket.duplicate_redirect && (
        <Dialog open={work.redirecting} onOpenChange={work.setRedirecting}>
          <DialogContent className="duplicate-dialog">
            <DialogHeader>
              <DialogTitle>Point this duplicate at the original</DialogTitle>
              <DialogDescription>
                {ticket.duplicate_of} became a duplicate of{" "}
                {ticket.duplicate_redirect}. Review the dependencies, then mark{" "}
                {ticket.reference} as a duplicate of {ticket.duplicate_redirect}{" "}
                instead.
              </DialogDescription>
            </DialogHeader>
            <Duplicates
              ticket={ticket}
              initialCanonical={ticket.duplicate_redirect}
              refresh={async () => {
                retry();
                await refresh();
              }}
              onDone={() => work.setRedirecting(false)}
              onCancel={() => work.setRedirecting(false)}
            />
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={work.reviewing} onOpenChange={work.setReviewing}>
        <DialogContent className="duplicate-dialog">
          <DialogHeader>
            <DialogTitle>Review dependency changes</DialogTitle>
            <DialogDescription>
              Move dependencies between {ticket.reference} and another ticket
              after a duplicate link was removed.
            </DialogDescription>
          </DialogHeader>
          <Duplicates
            ticket={ticket}
            startSeparate
            refresh={async () => {
              retry();
              await refresh();
            }}
            onDone={() => work.setReviewing(false)}
            onCancel={() => work.setReviewing(false)}
          />
        </DialogContent>
      </Dialog>
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
  const rows = work.rows.filter((row) => row.kind !== "subticket");
  // A duplicate closed by its source names a canonical issue that may not be a
  // local ticket; it is information and has no remove action.
  const external = externalDuplicateTarget(work.ticket);
  const externalAt = rows.findIndex((row) => row.kind === "duplicates");
  const linkAction = (
    <Button variant="ghost" size="sm" onClick={() => work.openLink()}>
      <Plus aria-hidden="true" />
      Add relationship
    </Button>
  );
  // Collapse to the bare action only after a successful read found nothing;
  // loading and failed look different from "no links".
  if (!current?.links || (rows.length === 0 && !external))
    return (
      <RailSection label="Relationships">
        <div id={`linked-work-${reference}`} className="linked-work" data-empty>
          {linkAction}
          {!current && (
            <span className="linked-work-state" role="status">
              Loading relationships…
            </span>
          )}
          {current && !current.links && (
            <span className="linked-work-state" role="alert">
              Could not load relationships: {current.failure}{" "}
              <Button variant="link" size="xs" onClick={work.retry}>
                Try again
              </Button>
            </span>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      </RailSection>
    );
  const split = externalAt < 0 ? rows.length : externalAt;
  const renderRow = (row: LinkRow, index: number) => (
    <li
      key={`${row.kind}-${row.reference}`}
      className="linked-work-row"
      data-kind={row.kind}
    >
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
      <span className="linked-work-reference">{row.reference}</span>
      <Button
        variant="link"
        className="linked-work-title"
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
      {isDuplicateKind(row.kind) &&
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
  );
  return (
    <RailSection label="Relationships">
      <div id={`linked-work-${reference}`} className="linked-work">
        {error && <p role="alert">{error}</p>}
        {current.failure && (
          <p role="alert">
            Relationships could not be refreshed: {current.failure}
          </p>
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
          <Button variant="ghost" size="sm" onClick={onOpenGraph}>
            <Network aria-hidden="true" />
            Dependencies
          </Button>
          {linkAction}
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
    <li className="linked-work-row" data-kind="duplicate_of" data-external>
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
        ) : (
          // A reference is monospace; "Unknown" is a word.
          <span
            className={
              target.kind === "unknown" ? undefined : "linked-work-reference"
            }
          >
            {label}
          </span>
        )}{" "}
        <span className="linked-work-note">{note}</span>
      </span>
    </li>
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
