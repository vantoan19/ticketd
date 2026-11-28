import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { Disclosure } from "@/components/ui/disclosure";
import { StatusDot } from "@/components/ui/status-dot";
import { Time } from "@/components/ui/time";
import { useChatAboutTicket } from "@/features/chats/use-ticket-chats";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { Project } from "@/lib/api/client";
import type { View } from "@/lib/api/plans";
import { firstSentence } from "@/lib/plain-text";
import type { PlanOverviewWork } from "./PlanOverview";
import "./plan-overview-work.css";

type WorkSections = PlanOverviewWork["sections"];
type WorkItem = WorkSections[keyof WorkSections][number];
type OpenTicket = (reference: string, trigger?: HTMLElement) => void;

export function PlanOverviewSections({
  work,
  updates,
  statusSince,
  projects,
  selected,
  onOpen,
}: {
  work: PlanOverviewWork;
  updates: View["latest_updates"];
  statusSince: View["status_since"];
  projects: readonly Project[];
  selected: string | null;
  onOpen: OpenTicket;
}) {
  const { inReview, inProgress, ready, blocked, done, notCounted } =
    work.sections;
  const subtickets = new Map<string, number>();
  for (const { ticket } of Object.values(work.sections).flat()) {
    const parent = ticket.parent?.reference;
    if (parent) subtickets.set(parent, (subtickets.get(parent) ?? 0) + 1);
  }
  const sections = [
    { label: "Needs you", items: inReview, attention: true },
    { label: "In progress", items: inProgress },
    { label: "Ready", items: ready },
    { label: "Blocked", items: blocked, folded: blocked.length > 3 },
    { label: "Done", items: done, folded: true, extra: notCounted },
  ];
  const rows = (items: readonly WorkItem[]) => (
    <ul className="plan-overview-work-rows" role="list">
      {items.map((item) => (
        <PlanOverviewRow
          key={item.ticket.reference}
          item={item}
          brief={updates[item.ticket.reference]?.brief.text ?? ""}
          timestamp={statusSince[item.ticket.reference]}
          subtickets={subtickets.get(item.ticket.reference) ?? 0}
          folder={
            projects.find(
              (project) =>
                project.id === item.ticket.project_id && !project.archived,
            )?.path ?? null
          }
          selected={selected === item.ticket.reference}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );

  return sections.map(({ label, items, attention, folded, extra }) => {
    if (!items.length && !extra?.length) return null;
    const content = (
      <>
        {items.length > 0 && rows(items)}
        {extra && extra.length > 0 && <NotCounted>{rows(extra)}</NotCounted>}
      </>
    );
    return folded ? (
      <FoldedWorkSection
        key={label}
        label={label}
        count={items.length}
        selection={
          [...items, ...(extra ?? [])].some(
            ({ ticket }) => ticket.reference === selected,
          )
            ? selected
            : null
        }
      >
        {content}
      </FoldedWorkSection>
    ) : (
      <WorkSection
        key={label}
        label={label}
        count={items.length}
        attention={attention}
      >
        {content}
      </WorkSection>
    );
  });
}

function WorkSection({
  label,
  count,
  attention,
  children,
}: {
  label: string;
  count: number;
  attention: boolean | undefined;
  children: ReactNode;
}) {
  const title = useId();
  return (
    <section aria-labelledby={title}>
      <h2 className="plan-overview-section-heading plan-overview-work-heading">
        {attention && <StatusDot tone="attention" />}
        <span id={title}>{label}</span>
        <Count>{count}</Count>
      </h2>
      {children}
    </section>
  );
}

function FoldedWorkSection({
  label,
  count,
  selection,
  children,
}: {
  label: string;
  count: number;
  selection: string | null;
  children: ReactNode;
}) {
  const title = useId();
  const [open, setOpen] = useState(selection !== null);
  const [lastSelection, setLastSelection] = useState(selection);
  if (selection !== lastSelection) {
    setLastSelection(selection);
    // Detail navigation and the progress strip can open a ticket in a fold.
    if (selection !== null) setOpen(true);
  }
  return (
    <section className="plan-overview-work-fold" aria-labelledby={title}>
      <Disclosure
        label={<span id={title}>{label}</span>}
        aria-label={`${label} ${count}`}
        count={count}
        open={open}
        onOpenChange={setOpen}
      >
        <div aria-hidden={!open}>{children}</div>
      </Disclosure>
    </section>
  );
}

function NotCounted({ children }: { children: ReactNode }) {
  const title = useId();
  return (
    <section className="plan-overview-not-counted" aria-labelledby={title}>
      <h3 id={title}>Not counted</h3>
      {children}
    </section>
  );
}

function PlanOverviewRow({
  item: { ticket, group, unblocks, waitsOn },
  brief,
  timestamp,
  subtickets,
  folder,
  selected,
  onOpen,
}: {
  item: WorkItem;
  brief: string;
  timestamp: string | undefined;
  subtickets: number;
  folder: string | null;
  selected: boolean;
  onOpen: OpenTicket;
}) {
  const chat = useChatAboutTicket(
    group === "Ready" && ticket.id
      ? { ...ticket, id: ticket.id, trashed: false }
      : undefined,
    folder,
  );
  const noteId = useId();
  const metaId = useId();
  const note =
    group === "In review" || group === "In progress"
      ? firstSentence(brief)
      : "";
  const blocker = group === "Blocked" ? waitsOn[0] : undefined;
  let meta = "";
  if (blocker) {
    const more = waitsOn.length - 1;
    meta = `after ${blocker.reference}${more ? ` +${more}` : ""}`;
  } else if (group === "Ready") {
    if (subtickets) meta = `Parent of ${subtickets}`;
    else if (unblocks) meta = `Unblocks ${unblocks}`;
  }
  const name = [
    `${ticket.reference} ${ticket.title}`,
    blocker
      ? `Blocked by ${waitsOn.map(({ reference, title }) => `${reference} ${title}`).join(", ")}`
      : group === "Not counted"
        ? ticket.status
        : group,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li
      className="plan-overview-work-row"
      data-note={note ? "" : undefined}
      data-selected={selected ? "" : undefined}
    >
      <button
        type="button"
        aria-label={name}
        aria-describedby={
          [note && noteId, meta && !blocker && metaId]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-current={selected || undefined}
        data-overview-reference={ticket.reference}
        className="plan-overview-row-open"
        onClick={(event) => onOpen(ticket.reference, event.currentTarget)}
      >
        <StatusIcon
          status={ticket.status}
          className="plan-overview-row-status"
          size={14}
          decorative
        />
        <span className="plan-overview-row-reference">{ticket.reference}</span>
        <span className="plan-overview-row-title">{ticket.title}</span>
        {meta && (
          <span className="plan-overview-row-meta" id={metaId}>
            {meta}
          </span>
        )}
        {note && (
          <span className="plan-overview-row-note" id={noteId}>
            {note}
          </span>
        )}
      </button>
      {chat && (
        <Button
          type="button"
          variant="ghost"
          size="compact"
          data-overview-action=""
          aria-label={`Start in Chat: ${ticket.reference}`}
          onClick={chat}
        >
          Start in Chat
        </Button>
      )}
      <PlanOverviewRowTime timestamp={timestamp} />
    </li>
  );
}

function PlanOverviewRowTime({ timestamp }: { timestamp: string | undefined }) {
  if (!timestamp) return null;
  return (
    <span className="plan-overview-row-time">
      <Time value={timestamp} format="compact" />
    </span>
  );
}
