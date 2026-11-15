import { Tooltip } from "@/components/ui/tooltip";
import { Alert, AlertActions, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLayoutEffect, useRef, useState } from "react";
import { Evidence } from "@/features/tickets/Evidence";
import { Backlinks, type MentionTarget } from "@/features/tickets/Backlinks";
import { FollowToggle } from "@/features/tickets/Attention";
import { Reminder } from "@/features/tickets/Reminder";
import { RailPlacement } from "@/features/tickets/rail-placement";
import { LinkedChats } from "@/features/chats/LinkedChats";
import { TicketProperties } from "@/features/tickets/TicketProperties";
import { LinkedWork, LinkedWorkDialogs } from "@/features/tickets/LinkedWork";
import { TicketFiles } from "@/features/tickets/TicketFiles";
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
import { NeedsReviewNotice } from "@/features/sync-review/NeedsReviewNotice";
import { PublicationNotice } from "@/features/tickets/PublishToSource";
import { externalSource, sourceState } from "@/features/tickets/ticket-source";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import { useSourcesConfigured } from "@/features/tickets/use-publication-preview";
import { useTicketTrash } from "@/features/tickets/use-ticket-trash";
import type { Project, Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";

type NoteTarget = { id: string; key: number };

/** One ticket's reading column and its property rail. */
export function TicketPage({
  ticket,
  active,
  narrow = false,
  outsideResults = false,
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
  /** Too narrow for the rail: it folds into a property strip under the title. */
  narrow?: boolean;
  /** The ticket is not among the list's current results. */
  outsideResults?: boolean;
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
  const sourcesConfigured = useSourcesConfigured();
  const trash = useTicketTrash(updateTicket, refresh);
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
  const updated = ticket.updated_at && (
    <Tooltip content={formatDateTime(ticket.updated_at)} side="bottom">
      <time dateTime={ticket.updated_at} tabIndex={0}>
        {relativeDateTime(ticket.updated_at, now)}
      </time>
    </Tooltip>
  );
  // One line under the title. Until a source is set up every ticket is local,
  // so it says only when it changed (DESIGN.md section 7).
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
                  <Tooltip content={original.display} side="bottom">
                    <span className="source-number" tabIndex={0}>
                      {originalLabel}
                    </span>
                  </Tooltip>
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
                <Tooltip
                  content={formatDateTime(source.closed_at)}
                  side="bottom"
                >
                  <time dateTime={source.closed_at} tabIndex={0}>
                    {relativeDateTime(source.closed_at, now)}
                  </time>
                </Tooltip>
              )}
            </>
          )}
        </>
      ) : sourcesConfigured || ticket.source ? (
        <span>Local ticket{updated && <> · updated {updated}</>}</span>
      ) : (
        updated && <span>Updated {updated}</span>
      )}
      {outsideResults && <span>Not in the current results</span>}
    </p>
  );
  // The source owns the title and description, so they are read, never edited.
  const contentLocked = Boolean(source?.content_locked);
  const attentionFor = (variant: "rail" | "strip") =>
    active &&
    !ticket.trashed && (
      <>
        <FollowToggle
          key={`follow-${ticket.reference}`}
          reference={ticket.reference}
          revision={revision}
          variant={variant}
        />
        <Reminder
          key={`reminder-${ticket.reference}`}
          reference={ticket.reference}
          revision={revision}
          variant={variant}
        />
      </>
    );
  const files = active && (
    <TicketFiles
      key={ticket.reference}
      ticket={ticket}
      revision={revision}
      refresh={refresh}
      onOpenUpdate={(id) => setUpdateTarget({ id, key: Date.now() })}
    />
  );
  const chats = active && (
    <LinkedChats
      ticket={ticket}
      folder={
        projects.find((project) => project.id === ticket.project_id)?.path ??
        null
      }
      chip={narrow}
    />
  );
  const relationships = active && (
    <LinkedWork work={work} select={select} onOpenGraph={onOpenGraph} />
  );
  // Folded, the rail's values sit under the title as one strip, in rail order.
  const stateAndStrip = (
    <>
      {stateLine}
      {narrow && (
        <TicketProperties
          layout="strip"
          chats={chats}
          attention={attentionFor("strip")}
          ticket={ticket}
          active={active}
          revision={revision}
          projects={projects}
          plans={plans}
          onSaved={updateTicket}
          refresh={refresh}
          onOpenTicket={select}
          onOpenNote={(id) => setUpdateTarget({ id, key: Date.now() })}
        />
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
      {/* Mounted here, not inside the rail or the narrow layout, so crossing
          the breakpoint never remounts an open review and drops its state. */}
      {active && !ticket.trashed && <LinkedWorkDialogs work={work} />}
      <div className="detail-document">
        {/* One notice for the whole state; the header and rail keep their shape. */}
        {ticket.trashed && (
          <Alert size="compact" role="status" className="mb-6">
            <AlertDescription>
              In Trash. Relationships are kept.
            </AlertDescription>
            <AlertActions>
              <Button
                variant="outline"
                size="sm"
                disabled={trash.pending}
                onClick={() => void trash.setTrashed(ticket.reference, false)}
              >
                Restore
              </Button>
            </AlertActions>
          </Alert>
        )}
        {active && (
          <NeedsReviewNotice kind="ticket" id={ticket.id} className="mb-6" />
        )}
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
            {stateAndStrip}
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
                      <p className="ticket-no-description">No description</p>
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
            {stateAndStrip}
          </TicketEditor>
        )}
        {active && (
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
          <RailPlacement value="column">
            <div className="detail-connected">
              {relationships}
              {files}
            </div>
          </RailPlacement>
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
          chats={chats}
          attention={attentionFor("rail")}
          active={active}
          revision={revision}
          projects={projects}
          plans={plans}
          onSaved={updateTicket}
          refresh={refresh}
          onOpenTicket={select}
          onOpenNote={(id) => setUpdateTarget({ id, key: Date.now() })}
        >
          {relationships}
          {files}
        </TicketProperties>
      )}
    </div>
  );
}
