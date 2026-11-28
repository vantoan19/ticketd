import {
  use,
  useEffect,
  useId,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Progress } from "@/components/ui/progress";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { IconButton } from "@/components/ui/icon-button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { RecordLink } from "@/components/ui/record-link";
import { Reference } from "@/components/ui/reference";
import { SectionHeader } from "@/components/ui/section-header";
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
import { linkLabel, type LinkKind, type LinkRow } from "./linked-work";
import { useLinkedGroup } from "./linked-group";
import { Backlinks, type MentionTarget } from "./Backlinks";
import { useOpenTicket } from "./open-ticket";
import {
  duplicateTargetParts,
  externalDuplicateTarget,
  externalSource,
} from "@/features/tickets/ticket-source";
import { RailPlacement } from "@/features/tickets/rail-placement";
import { ReferenceRow } from "@/features/tickets/ReferenceRow";
import { Presence } from "@/components/ui/motion";
import { orderBlockers, type LinkedWorkState } from "./useLinkedWork";
import "./linked-work.css";

const isDuplicateKind = (kind: LinkRow["kind"]) =>
  kind === "duplicate_of" || kind === "duplicates";

/** The dialogs the relationship actions open; one instance serves the rail and Subtickets. */
export function LinkedWorkDialogs({ work }: { work: LinkedWorkState }) {
  const { ticket, changed } = work;
  return (
    <>
      <LinkTicketDialog
        ticket={ticket}
        open={work.linking !== null}
        {...(work.linking && { initialKind: work.linking })}
        onOpenChange={(open) => {
          if (!open) work.closeLink();
        }}
        onLinked={() => changed()}
      />
      {ticket.duplicate_redirect && work.redirecting && (
        <Duplicates
          ticket={ticket}
          initialCanonical={ticket.duplicate_redirect}
          refresh={() => changed()}
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
          refresh={() => changed()}
          open
          onOpenChange={work.setReviewing}
          title="Review dependencies"
          description={`Move dependencies between ${ticket.reference} and another ticket.`}
        />
      )}
    </>
  );
}

const relatedKinds: LinkKind[] = ["related", "discovered_while", "discoveries"];
const openLimit = 7;
const activeStatuses = ["In review", "In progress", "Todo"];

export type LinkedWorkHandle = { openSubtickets(): void };

export function LinkedWork({
  work,
  select,
  onMention,
  ref,
}: {
  work: LinkedWorkState;
  select: (reference: string) => void;
  onMention: (target: MentionTarget) => void;
  ref?: Ref<LinkedWorkHandle>;
}) {
  const { ticket, reference, current, pending } = work;
  const titleId = useId();
  const mentions = useOpenTicket("backlinks");
  const documentLinks = useOpenTicket("documentBacklinks");
  const placement = use(RailPlacement);
  const density = placement === "column" ? "list" : "rail";
  const readOnly = ticket.trashed;
  const links = current?.links;
  const related = work.rows.filter((row) => relatedKinds.includes(row.kind));
  const subtickets = work.rows.filter((row) => row.kind === "subticket");
  const blockers = work.rows.filter((row) => row.kind === "blocked_by");
  const blocking = work.rows.filter((row) => row.kind === "blocks");
  const duplicates = work.rows.filter((row) => isDuplicateKind(row.kind));
  const allBlockers = links ? orderBlockers(work) : [];
  const subticketPartial = links?.children.next_offset != null;
  const total = subticketPartial
    ? (links?.children_progress.total ?? 0)
    : subtickets.length;
  const done = subticketPartial
    ? (links?.children_progress.done ?? 0)
    : subtickets.filter((row) => row.status === "Done").length;
  const groups = [
    {
      kind: "blocked_by",
      label: "Blocked by",
      rows: blockers,
      total: allBlockers.length,
      openTotal: allBlockers.filter((row) => row.unresolved).length,
      partial: links?.prerequisites.next_offset != null,
    },
    {
      kind: "subticket",
      label: "Subtickets",
      rows: subtickets,
      total,
      partial: subticketPartial,
      openTotal: subticketPartial ? total - done : undefined,
      doneTotal: done,
    },
    {
      kind: "blocks",
      label: "Blocks",
      rows: blocking,
      total: blocking.length,
      partial: links?.blocking.next_offset != null,
    },
    {
      kind: "related",
      label: "Related",
      rows: related,
      total: related.length,
      partial: [
        links?.related,
        links?.discovered_while,
        links?.discoveries,
      ].some((page) => page?.next_offset != null),
    },
  ] as const;
  const [blockersOpen, setBlockersOpen] = useLinkedGroup(
    ticket.id,
    "blocked_by",
    groups[0].openTotal > 0,
  );
  const [subticketsOpen, setSubticketsOpen] = useLinkedGroup(
    ticket.id,
    "subticket",
    (groups[1].openTotal ?? subtickets.filter(isOpen).length) > 0,
  );
  const [blockingOpen, setBlockingOpen] = useLinkedGroup(
    ticket.id,
    "blocks",
    blocking.some(isOpen),
  );
  const [relatedOpen, setRelatedOpen] = useLinkedGroup(
    ticket.id,
    "related",
    related.some(isOpen),
  );
  const disclosures = [
    [blockersOpen, setBlockersOpen],
    [subticketsOpen, setSubticketsOpen],
    [blockingOpen, setBlockingOpen],
    [relatedOpen, setRelatedOpen],
  ] as const;
  useImperativeHandle(
    ref,
    () => ({
      openSubtickets: () => setSubticketsOpen(true),
    }),
    [setSubticketsOpen],
  );

  const { loadingMore, moreFailure, showMore } = work;
  const needsPage =
    groups.some(
      (group, index) =>
        group.partial &&
        (disclosures[index]?.[0] ||
          (!("openTotal" in group) && !group.rows.some(isOpen))),
    ) || links?.duplicates.next_offset != null;
  useEffect(() => {
    if (needsPage && !loadingMore && !moreFailure) showMore();
  }, [needsPage, loadingMore, moreFailure, showMore, links]);

  const external = externalDuplicateTarget(ticket);
  const isGitHubOwned = externalSource(ticket)?.provider === "github";
  const order = work.rows.map((row) => `${row.kind}-${row.reference}`).join();
  const renderRow = (row: LinkRow) => (
    <ReferenceRow
      key={`${row.kind}-${row.reference}`}
      kind={row.kind}
      animated
      layoutDependency={order}
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
  const hasRelationships =
    !current ||
    current.failure ||
    work.error ||
    external ||
    duplicates.length > 0 ||
    groups.some((group) => group.total > 0);
  if (
    !hasRelationships &&
    !mentions.value?.total &&
    !mentions.failure &&
    !documentLinks.length
  )
    return null;
  return (
    <section
      className="linked-work"
      id={`linked-work-${reference}`}
      aria-labelledby={titleId}
    >
      <SectionHeader title="Linked" titleId={titleId} level={2}>
        {total > 0 && (
          <div className="linked-work-progress">
            <Progress
              aria-label="Subticket progress"
              value={done}
              max={total}
            />
            <span className="linked-work-note">
              {done === total
                ? `All ${total} done`
                : `${done} of ${total} done`}
            </span>
          </div>
        )}
      </SectionHeader>
      {!current && (
        <div
          className="linked-work-loading"
          role="status"
          aria-label="Loading relationships"
        >
          <Skeleton shape="circle" className="size-4" />
          <Skeleton className="h-3 w-11" />
          <Skeleton className="h-3 flex-1" />
        </div>
      )}
      {current?.failure && (
        <FailureState
          size="inline"
          failure={current.failure}
          onRetry={work.retry}
        />
      )}
      {groups.map((group, index) => {
        const disclosure = disclosures[index];
        if (!disclosure || (group.total === 0 && !group.partial)) return null;
        const [open, setOpen] = disclosure;
        return (
          <RelationshipGroup
            key={group.kind}
            {...group}
            open={open}
            onOpenChange={setOpen}
            renderRow={renderRow}
            note={
              group.kind === "subticket" && isGitHubOwned
                ? "Subtickets stay local; publishing never includes them."
                : undefined
            }
          />
        );
      })}
      <Backlinks
        mentions={mentions}
        documentLinks={documentLinks}
        select={onMention}
      />
      {(["duplicate_of", "duplicates"] as const).map((kind) => {
        const rows = duplicates.filter((row) => row.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section aria-label={linkLabel(kind)} key={kind}>
            <div className="linked-work-group">{linkLabel(kind)}</div>
            <ul className="reference-rows">
              <Presence initial={false} mode="popLayout">
                {rows.map(renderRow)}
              </Presence>
            </ul>
          </section>
        );
      })}
      {external && <ExternalTarget target={external} select={select} />}
      {!readOnly && ticket.duplicate_redirect && (
        <p className="linked-work-note">
          {ticket.duplicate_of} is itself a duplicate of{" "}
          {ticket.duplicate_redirect}.{" "}
          <Button
            variant="link"
            size="inline"
            onClick={() => work.setRedirecting(true)}
          >
            Point this at {ticket.duplicate_redirect}
          </Button>
        </p>
      )}
      {loadingMore && (
        <span className="linked-work-note" role="status">
          Loading more relationships…
        </span>
      )}
      {moreFailure && (
        <FailureState
          size="inline"
          failure={moreFailure}
          onRetry={work.retry}
        />
      )}
      {work.error && <FailureAlert size="compact" failure={work.error} />}
    </section>
  );
}

function isOpen(row: LinkRow) {
  return row.kind === "blocked_by"
    ? row.unresolved
    : activeStatuses.includes(row.status);
}

function RelationshipGroup({
  kind,
  label,
  rows,
  partial,
  total,
  openTotal,
  doneTotal,
  open,
  onOpenChange,
  renderRow,
  note,
}: {
  kind: string;
  label: string;
  rows: LinkRow[];
  partial: boolean;
  total: number;
  openTotal?: number | undefined;
  doneTotal?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  renderRow: (row: LinkRow) => ReactNode;
  note: string | undefined;
}) {
  const openRows = rows.filter(isOpen).sort((a, b) => {
    const rank = (status: string) => {
      const index = activeStatuses.indexOf(status);
      return index === -1 ? activeStatuses.length : index;
    };
    return rank(a.status) - rank(b.status);
  });
  const doneRows = rows.filter((row) => !isOpen(row) && row.status === "Done");
  const otherFinished = rows.filter(
    (row) => !isOpen(row) && row.status !== "Done",
  );
  const openCount = openTotal ?? openRows.length;
  const doneCount = doneTotal ?? doneRows.length;
  const review = openRows.filter((row) => row.status === "In review").length;
  const progress = openRows.filter(
    (row) => row.status === "In progress",
  ).length;
  let summary = openCount > 0 ? `${openCount} open` : "all finished";
  if (kind === "subticket") {
    if (total === doneCount) summary = "all done";
    else if (review > 0) summary = `${review} in review`;
    else if (progress > 0) summary = `${progress} in progress`;
  }
  const unknownTotal = partial && kind !== "subticket" && kind !== "blocked_by";
  if (unknownTotal && !openCount) summary = "loading links";
  return (
    <Disclosure
      className="linked-work-disclosure"
      label={
        <>
          {label} <span className="linked-work-note">{summary}</span>
        </>
      }
      count={unknownTotal ? `${total}+` : total}
      open={open}
      onOpenChange={onOpenChange}
    >
      {note && <p className="linked-work-note">{note}</p>}
      <ul className="reference-rows">
        <Presence initial={false} mode="popLayout">
          {openRows.slice(0, openLimit).map(renderRow)}
        </Presence>
      </ul>
      <RelationshipFold
        label="more open"
        count={Math.max(0, openCount - openLimit)}
        rows={openRows.slice(openLimit)}
        renderRow={renderRow}
      />
      <RelationshipFold
        label="done"
        count={doneCount}
        rows={doneRows}
        renderRow={renderRow}
      />
      <RelationshipFold
        label="finished"
        count={otherFinished.length}
        rows={otherFinished}
        renderRow={renderRow}
      />
    </Disclosure>
  );
}

function RelationshipFold({
  label,
  count,
  rows,
  renderRow,
}: {
  label: string;
  count: number;
  rows: LinkRow[];
  renderRow: (row: LinkRow) => ReactNode;
}) {
  if (count === 0) return null;
  const preview = rows.slice(0, 2).map((row) => row.reference);
  const name = [`${count} ${label}`, preview.join(", ")]
    .filter(Boolean)
    .join(": ");
  return (
    <Disclosure
      className="linked-work-fold"
      label={`${name}${preview.length > 0 && count > preview.length ? ` +${count - preview.length}` : ""}`}
    >
      <ul className="reference-rows">
        <Presence initial={false} mode="popLayout">
          {rows.map(renderRow)}
        </Presence>
      </ul>
    </Disclosure>
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
  if (row.kind === "discovered_while" || row.kind === "discoveries")
    parts.push(linkLabel(row.kind));
  return parts.join(" · ");
}
