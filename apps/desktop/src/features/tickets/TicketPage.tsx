import { EmptyState } from "@/components/ui/empty-state";
import { useLayoutEffect, useRef, useState } from "react";
import { Evidence } from "@/features/tickets/Evidence";
import { Backlinks, type MentionTarget } from "@/features/tickets/Backlinks";
import { Follow } from "@/features/tickets/Inbox";
import { Reminder } from "@/features/tickets/Reminder";
import { RailSection } from "@/features/tickets/RailSection";
import { TicketProperties } from "@/features/tickets/TicketProperties";
import { LinkedWork, LinkedWorkDialogs } from "@/features/tickets/LinkedWork";
import { TicketDocuments } from "@/features/tickets/TicketDocuments";
import { Subtickets } from "@/features/tickets/Subtickets";
import { useLinkedWork } from "@/features/tickets/useLinkedWork";
import { Activity } from "@/features/tickets/Activity";
import { SourceConversation } from "@/features/tickets/SourceConversation";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { StatusDot } from "@/components/ui/status-dot";
import { ReadOnlyTitle, SourceDescription } from "./ReadOnlySource";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { SourceUnavailableNotice } from "@/features/tickets/SourceUnavailableNotice";
import { PublicationNotice } from "@/features/tickets/PublishToSource";
import { externalSource, sourceState } from "@/features/tickets/ticket-source";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import type { Project, Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";

type NoteTarget = { id: string; key: number };

/** One ticket's reading column and its property rail. */
export function TicketPage({
  ticket,
  active,
  narrow = false,
  projects,
  plans,
  revision,
  refresh,
  updateTicket,
  select,
  onOpenGraph,
  noteTarget,
  mention,
  onMention,
}: {
  ticket: Ticket;
  /** Only the selected ticket reads its links, evidence, and backlinks. */
  active: boolean;
  /** Too narrow for the rail: its controls fold into a chip bar under the title. */
  narrow?: boolean;
  projects: Project[];
  plans: Plan[];
  revision: number;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
  select: (reference: string | null) => void;
  onOpenGraph: () => void;
  noteTarget: NoteTarget | null;
  /** The description mention being followed, once the ticket has been fetched. */
  mention: (MentionTarget & { key: number }) | null;
  onMention: (target: MentionTarget) => void;
}) {
  const now = useNow();
  const [updateTarget, setUpdateTarget] = useState<NoteTarget | null>(null);
  const work = useLinkedWork(ticket, revision, refresh, active);
  // Pages stay mounted while hidden and the shared scrollers keep their
  // offset, so showing a ticket starts it at the top: document, rail, detail.
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = page.current;
    if (!active || !content) return;
    for (const node of [
      content.parentElement,
      content,
      content.querySelector(".detail-document"),
      content.querySelector(":scope > .ticket-properties"),
    ]) {
      if (node) node.scrollTop = 0;
    }
  }, [active]);
  // The reading column: title, state, description, subtickets, evidence,
  // backlinks, then notes and history.
  const source = externalSource(ticket);
  const state = source ? sourceState(source) : null;
  const original =
    source?.state.state === "closed" &&
    !source.unavailable &&
    source.state.reason === "duplicate" &&
    source.duplicate_target?.kind === "external"
      ? source.duplicate_target
      : null;
  const originalLabel =
    original && source && original.display.startsWith(`${source.place}#`)
      ? original.display.slice(source.place.length)
      : original?.display;
  const stateLine = (
    <p className="ticket-state-line">
      {source && state ? (
        <>
          <span className="ticket-source-state">
            {state.tone && <StatusDot tone={state.tone} size={10} />}
            <span>
              {state.text}
              {original && (
                <>
                  {" "}
                  of{" "}
                  <span className="source-number" title={original.display}>
                    {originalLabel}
                  </span>
                  {original.last_known && " (last known)"}
                </>
              )}
            </span>
          </span>
          {source.unavailable ? (
            <span>
              Last synced copy from{" "}
              {source.last_refreshed_at
                ? formatDateTime(source.last_refreshed_at)
                : "an earlier sync"}
            </span>
          ) : (
            <>
              {source.state.state === "open" && <span>{source.number}</span>}
              {source.closed_at && (
                <time
                  dateTime={source.closed_at}
                  title={formatDateTime(source.closed_at)}
                >
                  {relativeDateTime(source.closed_at, now)}
                </time>
              )}
            </>
          )}
        </>
      ) : (
        <span>
          Local ticket
          {ticket.updated_at && (
            <span title={formatDateTime(ticket.updated_at)}>
              {" "}
              · updated {relativeDateTime(ticket.updated_at, now)}
            </span>
          )}
        </span>
      )}
    </p>
  );
  // The source owns the title and description, so they are read, never edited.
  const contentLocked = Boolean(source?.content_locked);
  const attention = active && !ticket.trashed && (
    <>
      <Follow
        key={`follow-${ticket.reference}`}
        reference={ticket.reference}
        revision={revision}
        chip={narrow}
      />
      <Reminder
        key={`reminder-${ticket.reference}`}
        reference={ticket.reference}
        revision={revision}
        {...(narrow && { variant: "outline" as const })}
      />
    </>
  );
  const documents = active && !ticket.trashed && (
    <TicketDocuments
      ticket={ticket}
      revision={revision}
      refresh={refresh}
      onOpenUpdate={(id) => setUpdateTarget({ id, key: Date.now() })}
    />
  );
  const relationships = active && (
    <>
      <LinkedWork work={work} select={select} onOpenGraph={onOpenGraph} />
      {!ticket.trashed && <LinkedWorkDialogs work={work} />}
    </>
  );
  // Folded, the rail's controls sit under the title in rail order.
  const stateAndChips = (
    <>
      {stateLine}
      {narrow && (
        <TicketProperties
          layout="chips"
          ticket={ticket}
          active={active}
          revision={revision}
          projects={projects}
          plans={plans}
          onSaved={updateTicket}
          refresh={refresh}
          onOpenTicket={select}
          onOpenNote={(id) => setUpdateTarget({ id, key: Date.now() })}
        >
          {attention}
        </TicketProperties>
      )}
    </>
  );
  return (
    <div
      ref={page}
      className="detail-content"
      hidden={!active}
      data-trashed={ticket.trashed || undefined}
    >
      <div className="detail-document">
        {active && (
          <SourceUnavailableNotice ticket={ticket} refresh={refresh} />
        )}
        {active && <PublicationNotice ticket={ticket} refresh={refresh} />}
        {ticket.trashed || contentLocked ? (
          <>
            {source && contentLocked ? (
              <ReadOnlyTitle title={ticket.title} source={source} />
            ) : (
              <h3 className="detail-title">{ticket.title}</h3>
            )}
            {stateAndChips}
            <div className="editor-body">
              {source && contentLocked ? (
                <SourceDescription
                  ticket={ticket}
                  source={source}
                  select={select}
                  revision={revision}
                />
              ) : (
                <>
                  <p className="sr-only">Description</p>
                  <div className="markdown-preview description-document">
                    {ticket.body.trim() ? (
                      <MarkdownDocument
                        source={ticket.body}
                        select={select}
                        revision={revision}
                      />
                    ) : (
                      <EmptyState size="hint" title="No description." />
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <TicketEditor
            ticket={ticket}
            onSaved={updateTicket}
            select={select}
            revision={revision}
            mention={mention}
          >
            {stateAndChips}
          </TicketEditor>
        )}
        {active && !ticket.trashed && (
          <Subtickets work={work} select={select} external={Boolean(source)} />
        )}
        {active && (
          <Evidence
            reference={ticket.reference}
            revision={revision}
            trashed={ticket.trashed}
            refresh={refresh}
          />
        )}
        {narrow && (
          <div className="detail-connected">
            {documents}
            {relationships}
          </div>
        )}
        {active && (
          <Backlinks
            ticketId={ticket.id}
            reference={ticket.reference}
            revision={revision}
            select={onMention}
          />
        )}
        {active && ticket.source && (
          <SourceConversation
            source={ticket.source}
            reference={ticket.reference}
            revision={revision}
            select={select}
          />
        )}
        <Activity
          reference={ticket.reference}
          ticketId={ticket.id}
          target={
            updateTarget && (!noteTarget || updateTarget.key > noteTarget.key)
              ? updateTarget
              : noteTarget
          }
          projects={projects}
          plans={plans}
          status={ticket.status}
          revision={revision}
          active={active}
          trashed={ticket.trashed}
          select={select}
          latestNoteId={ticket.latest_update?.activity_id}
          sourceName={source?.provider_name}
          onChanged={refresh}
        />
      </div>
      {!narrow && (
        <TicketProperties
          ticket={ticket}
          active={active}
          revision={revision}
          projects={projects}
          plans={plans}
          onSaved={updateTicket}
          refresh={refresh}
          onOpenTicket={select}
          onOpenNote={(id) => setUpdateTarget({ id, key: Date.now() })}
        >
          {documents}
          {relationships}
          {attention && (
            <RailSection label="Attention">
              <div className="rail-attention">{attention}</div>
            </RailSection>
          )}
        </TicketProperties>
      )}
    </div>
  );
}
