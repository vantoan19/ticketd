import { Evidence } from "@/features/tickets/Evidence";
import { Backlinks, type MentionTarget } from "@/features/tickets/Backlinks";
import { Follow } from "@/features/tickets/Inbox";
import { Reminder } from "@/features/tickets/Reminder";
import { RailSection } from "@/features/tickets/RailSection";
import { TicketProperties } from "@/features/tickets/TicketProperties";
import { LinkedWork, LinkedWorkDialogs } from "@/features/tickets/LinkedWork";
import { Subtickets } from "@/features/tickets/Subtickets";
import { useLinkedWork } from "@/features/tickets/useLinkedWork";
import { Activity } from "@/features/tickets/Activity";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { StatusDot } from "@/components/ui/status-dot";
import { SourceLink } from "@/features/tickets/SourceLink";
import { SourceUnavailableNotice } from "@/features/tickets/SourceUnavailableNotice";
import {
  externalNumber,
  externalSource,
  providerName,
  sourceState,
} from "@/features/tickets/ticket-source";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import type { Project, Ticket } from "@/lib/api/client";
import type { Effort } from "@/lib/api/efforts";

type NoteTarget = { id: string; key: number };

/** One ticket's reading column and its property rail. */
export function TicketPage({
  ticket,
  active,
  projects,
  efforts,
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
  projects: Project[];
  efforts: Effort[];
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
  const work = useLinkedWork(
    ticket,
    revision,
    refresh,
    active && !ticket.trashed,
  );
  // The reading column: title, state, description, subtickets, evidence,
  // backlinks, then notes and history.
  const source = externalSource(ticket);
  const state = source ? sourceState(source) : null;
  const stateLine = (
    <p className="ticket-state-line">
      {source && state ? (
        <>
          {state.tone && <StatusDot tone={state.tone} size={8} />}
          {state.text} · {externalNumber(source)}
        </>
      ) : (
        "Local ticket"
      )}
    </p>
  );
  // The source owns the title and description, so they are read, never edited.
  const contentLocked = Boolean(source?.content_locked);
  return (
    <div
      className="detail-content"
      hidden={!active}
      data-trashed={ticket.trashed || undefined}
    >
      <div className="detail-document">
        {active && (
          <SourceUnavailableNotice ticket={ticket} refresh={refresh} />
        )}
        {ticket.trashed || contentLocked ? (
          <>
            <h3 className="detail-title">{ticket.title}</h3>
            {stateLine}
            <div className="editor-body">
              {source && contentLocked ? (
                <section
                  className="source-card"
                  aria-label={`Description from ${providerName(source.provider)}, read-only`}
                >
                  <header className="source-card-header">
                    <span>{providerName(source.provider)} · Read-only</span>
                    <SourceLink url={source.url}>
                      Edit on {providerName(source.provider)}
                    </SourceLink>
                  </header>
                  <div className="markdown-preview description-document">
                    <MarkdownDocument
                      source={ticket.body}
                      select={select}
                      revision={revision}
                    />
                  </div>
                </section>
              ) : (
                <>
                  <p className="description-heading">Description</p>
                  <div className="markdown-preview description-document">
                    <MarkdownDocument
                      source={ticket.body}
                      select={select}
                      revision={revision}
                    />
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
            {stateLine}
          </TicketEditor>
        )}
        {active && !ticket.trashed && (
          <Subtickets work={work} select={select} />
        )}
        {active && !ticket.trashed && source && (
          <p className="source-caption">
            Subtickets stay in ticketd; publishing this ticket never publishes
            them.
          </p>
        )}
        {active && (
          <Evidence
            reference={ticket.reference}
            revision={revision}
            trashed={ticket.trashed}
            refresh={refresh}
          />
        )}
        {active && (
          <Backlinks
            reference={ticket.reference}
            revision={revision}
            select={onMention}
          />
        )}
        {source && (
          <p className="source-caption">
            Notes stay in ticketd and are never sent to{" "}
            {providerName(source.provider)}.
          </p>
        )}
        <Activity
          reference={ticket.reference}
          target={noteTarget}
          projects={projects}
          efforts={efforts}
          status={ticket.status}
          revision={revision}
          active={active}
          trashed={ticket.trashed}
          select={select}
        />
      </div>
      <TicketProperties
        ticket={ticket}
        projects={projects}
        efforts={efforts}
        onSaved={updateTicket}
        refresh={refresh}
        onOpenTicket={select}
      >
        {active && !ticket.trashed && (
          <>
            <LinkedWork work={work} select={select} onOpenGraph={onOpenGraph} />
            <LinkedWorkDialogs work={work} />
          </>
        )}
        {active && (
          <RailSection label="Attention">
            <div className="rail-attention">
              <Follow
                key={`follow-${ticket.reference}`}
                reference={ticket.reference}
                revision={revision}
              />
              <Reminder
                key={`reminder-${ticket.reference}`}
                reference={ticket.reference}
                revision={revision}
              />
            </div>
          </RailSection>
        )}
      </TicketProperties>
    </div>
  );
}
