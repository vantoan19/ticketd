import { use, useContext, useState } from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { Network, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { Pager } from "@/components/ui/pager";
import { RecordLink } from "@/components/ui/record-link";
import { Reference } from "@/components/ui/reference";
import { Skeleton } from "@/components/ui/skeleton";
import { SourceLink } from "@/features/tickets/SourceLink";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Duplicates } from "@/features/tickets/Duplicates";
import { LinkTicketDialog } from "@/features/tickets/LinkTicketDialog";
import type { DuplicateTarget } from "@/lib/api/client";
import {
  linkLabel,
  type AddableKind,
  type LinkKind,
  type LinkRow,
} from "@/features/tickets/linked-work";
import {
  duplicateTargetParts,
  externalDuplicateTarget,
  externalSource,
} from "@/features/tickets/ticket-source";
import { RailRow, RailSection } from "@/features/tickets/RailSection";
import { RailPlacement } from "@/features/tickets/rail-placement";
import { ReferenceRow } from "@/features/tickets/ReferenceRow";
import type { LinkedWorkState } from "@/features/tickets/useLinkedWork";
import "./linked-work.css";

const isDuplicateKind = (kind: LinkRow["kind"]) =>
  kind === "duplicate_of" || kind === "duplicates";

/** The "+" a relationship group offers, by kind; Parent and duplicates have none. */
const addLabels: Partial<Record<LinkKind, string>> = {
  blocked_by: "Add a blocker",
  blocks: "Add a ticket this blocks",
  related: "Add a related ticket",
  discovered_while: "Add where this was discovered",
  discoveries: "Add a discovery",
};

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
          title="Review dependencies"
          description={`Move dependencies between ${ticket.reference} and another ticket.`}
        />
      )}
    </>
  );
}

/**
 * Every link except subtickets as the rail's Relationships section, grouped by
 * meaning, each group with its own "+". Rows are two-line ReferenceRows; in a
 * narrow pane's reading column they are one-line rows under a section header.
 * Subtickets read under the description instead.
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
  const { reference, current, pending } = work;
  const error = work.error?.kind === "subticket" ? null : work.error;
  const density = use(RailPlacement) === "column" ? "list" : "rail";
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
  const graph = (
    <RailRow
      icon={<Network aria-hidden="true" />}
      muted
      onClick={() =>
        openContextGraph ? openContextGraph(reference) : onOpenGraph()
      }
    >
      {openContextGraph ? "Open context graph" : "Dependencies"}
    </RailRow>
  );
  if (!current?.links || (rows.length === 0 && !external)) {
    if (readOnly && current?.links) return null;
    return (
      <RailSection label="Relationships">
        {!current && (
          <Skeleton
            className="h-8"
            role="status"
            aria-label="Loading relationships"
          />
        )}
        {current && !current.links && current.failure && (
          <FailureState
            size="inline"
            failure={current.failure}
            onRetry={work.retry}
          />
        )}
        {current?.links && !readOnly && (
          <RailRow
            icon={<Plus aria-hidden="true" />}
            muted
            onClick={() => work.openLink()}
          >
            Add relationship
          </RailRow>
        )}
        {current?.links && openContextGraph && graph}
        {error && <FailureAlert size="compact" failure={error.failure} />}
      </RailSection>
    );
  }
  const groups: { kind: LinkKind; rows: LinkRow[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.kind === row.kind) last.rows.push(row);
    else groups.push({ kind: row.kind, rows: [row] });
  }
  const renderRow = (row: LinkRow) => (
    <ReferenceRow
      key={`${row.kind}-${row.reference}`}
      kind={row.kind}
      density={density}
      reference={row.reference}
      title={row.title}
      status={row.status}
      statusLabel={statusText(row)}
      caption={statusText(row)}
      onOpen={() => select(row.reference)}
      action={
        readOnly ? undefined : isDuplicateKind(row.kind) ? (
          externalSource(work.ticket)?.status_locked ? undefined : (
            <RemoveDuplicate
              row={row}
              ticket={reference}
              disabled={pending}
              onRemove={() => void work.remove(row)}
            />
          )
        ) : (
          <IconButton
            label={`Remove ${row.reference} from ${linkLabel(row.kind)}`}
            size="icon-xs"
            tooltipSide="top"
            disabled={pending}
            onClick={() => void work.remove(row)}
          >
            <X aria-hidden="true" />
          </IconButton>
        )
      }
    />
  );
  const addFor = (kind: LinkKind) => {
    const label = addLabels[kind];
    if (readOnly || !label) return null;
    return (
      <IconButton
        label={label}
        size="icon-xs"
        tooltipSide="top"
        onClick={() => work.openLink(kind as AddableKind)}
      >
        <Plus aria-hidden="true" />
      </IconButton>
    );
  };
  return (
    <RailSection
      label="Relationships"
      {...(!readOnly && {
        actions: (
          <IconButton
            label="Add relationship"
            tooltipSide="top"
            onClick={() => work.openLink()}
          >
            <Plus aria-hidden="true" />
          </IconButton>
        ),
      })}
    >
      {current.failure && (
        <FailureState
          size="inline"
          failure={current.failure}
          onRetry={work.retry}
        />
      )}
      <div className="linked-work" id={`linked-work-${reference}`}>
        {groups.map((group, index) => (
          <section
            key={`${group.kind}-${index}`}
            aria-label={linkLabel(group.kind)}
          >
            <div className="linked-work-group">
              <span>{linkLabel(group.kind)}</span>
              {addFor(group.kind)}
            </div>
            <ul className="reference-rows">{group.rows.map(renderRow)}</ul>
          </section>
        ))}
        {external && <ExternalTarget target={external} select={select} />}
      </div>
      {work.ticket.duplicate_redirect && (
        <p className="linked-work-note">
          {work.ticket.duplicate_of} is itself a duplicate of{" "}
          {work.ticket.duplicate_redirect}.{" "}
          <Button
            variant="link"
            size="inline"
            onClick={() => work.setRedirecting(true)}
          >
            Point this at {work.ticket.duplicate_redirect}
          </Button>
        </p>
      )}
      {work.more !== null && (
        <Pager noun="relationships" onMore={() => void work.showMore()} />
      )}
      {error && <FailureAlert size="compact" failure={error.failure} />}
      {graph}
    </RailSection>
  );
}

/** The canonical issue a source named for a duplicate, without pretending it is a local ticket. */
function ExternalTarget({
  target,
  select,
}: {
  target: DuplicateTarget;
  select: (reference: string) => void;
}) {
  const { label, ticket, note, url } = duplicateTargetParts(target);
  return (
    <section aria-label={linkLabel("duplicate_of")}>
      <div className="linked-work-group">
        <span>{linkLabel("duplicate_of")}</span>
      </div>
      <p className="linked-work-external">
        {ticket ? (
          <RecordLink onClick={() => select(ticket)}>{label}</RecordLink>
        ) : url ? (
          <SourceLink url={url}>{label}</SourceLink>
        ) : // A reference is monospace; "Unknown" is a word.
        target.kind === "unknown" ? (
          <span>{label}</span>
        ) : (
          <Reference>{label}</Reference>
        )}{" "}
        <span className="linked-work-note">{note}</span>
      </p>
    </section>
  );
}

/**
 * Removing a duplicate link is not a plain delete: it restores the duplicate's
 * earlier status and leaves moved dependencies where they are. A small confirm
 * says so; after it, the status line offers Review dependencies.
 */
function RemoveDuplicate({
  row,
  ticket,
  disabled,
  onRemove,
}: {
  row: LinkRow;
  ticket: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const duplicate = row.kind === "duplicate_of" ? ticket : row.reference;
  const canonical = row.kind === "duplicate_of" ? row.reference : ticket;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label={`Remove ${row.reference} from ${linkLabel(row.kind)}`}
          size="icon-xs"
          tooltipSide="top"
          disabled={disabled}
        >
          <X aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Remove duplicate link"
        className="linked-work-confirm"
      >
        <PopoverHeader>
          <PopoverTitle>Remove the duplicate link?</PopoverTitle>
          <PopoverDescription>
            {duplicate} returns to the status it had before. Dependencies moved
            to {canonical} stay there.
          </PopoverDescription>
        </PopoverHeader>
        <div className="linked-work-confirm-actions">
          <Button
            variant="ghost"
            size="sm"
            autoFocus
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
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
  if (row.trashed) parts.push("in Trash");
  return parts.join(" · ");
}
