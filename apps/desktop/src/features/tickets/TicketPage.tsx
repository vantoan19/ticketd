import { TicketCommandPicker } from "./TicketCommandPicker";
import { useContext } from "react";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { TicketCommandContext } from "@/lib/ticket-command-actions";
import { Tooltip } from "@/components/ui/tooltip";
import { Alert, AlertActions, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Evidence } from "@/features/tickets/Evidence";
import { Backlinks, type MentionTarget } from "@/features/tickets/Backlinks";
import { Reminder } from "@/features/tickets/Reminder";
import { RailPlacement } from "@/features/tickets/rail-placement";
import { TicketProperties } from "@/features/tickets/TicketProperties";
import { LinkedWork, LinkedWorkDialogs } from "@/features/tickets/LinkedWork";
import {
  TicketFiles,
  type FileAddRequest,
} from "@/features/tickets/TicketFiles";
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
import {
  RunNotices,
  TicketRunsSection,
} from "@/features/automations/TicketRuns";
import { useTicketRuns } from "@/features/automations/use-ticket-runs";
import { PublicationNotice } from "@/features/tickets/PublishToSource";
import {
  externalSource,
  sourceReference,
  sourceState,
} from "@/features/tickets/ticket-source";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import { useSourcesConfigured } from "@/features/tickets/use-publication-preview";
import { useTicketTrash } from "@/features/tickets/use-ticket-trash";
import type { Project } from "@/lib/api/client";
import { useOpenTicket } from "./open-ticket";
import { useWorkspaceChange } from "@/lib/workspace-change";
import type { Plan } from "@/lib/api/plans";

type NoteTarget = { id: string; key: number };

/** The ticket document with its wrapping properties and linked context. */
export function TicketPage({
  active,
  expanded = false,
  swap = false,
  leaving = false,
  outsideResults = false,
  projects,
  plans,
  select,
  onOpenGraph,
  noteTarget,
  mention,
  onMention,
}: {
  /** Only the selected ticket reads its links, evidence, and backlinks. */
  active: boolean;
  expanded?: boolean;
  /** Shown after another open ticket: its document fades up once that one has left. */
  swap?: boolean;
  /** Not the open ticket any more, kept on screen for one exit while it fades out. */
  leaving?: boolean;
  /** The ticket is not among the list's current results. */
  outsideResults?: boolean;
  projects: Project[];
  plans: Plan[];
  select: (reference: string | null) => void;
  onOpenGraph: () => void;
  noteTarget: NoteTarget | null;
  /** The description mention being followed, once the ticket has been fetched. */
  mention: (MentionTarget & { key: number }) | null;
  onMention: (target: MentionTarget) => void;
}) {
  // A known saved list copy (`opening`) reserves geometry until the fresh
  // read of the record settles.
  const { record: ticket, opening, fresh, changed } = useOpenTicket();
  // Readers not yet on the Open Ticket (the source's conversation, rendered
  // Markdown, the editor's conflict check) follow the Workspace's change.
  const revision = useWorkspaceChange();
  const now = useNow();
  const openCommand = useContext(TicketCommandContext);
  const [updateTarget, setUpdateTarget] = useState<NoteTarget | null>(null);
  const work = useLinkedWork();
  const sourcesConfigured = useSourcesConfigured();
  const trash = useTicketTrash(changed);
  // Evidence and Files have their add actions under the description.
  const [evidenceRequest, setEvidenceRequest] = useState(0);
  const [fileAddRequest, setFileAddRequest] = useState<FileAddRequest | null>(
    null,
  );
  const [fileAddTarget, setFileAddTarget] = useState<HTMLButtonElement | null>(
    null,
  );
  const noSubtickets = work.current?.links?.children_progress.total === 0;
  const noRelationships =
    Boolean(work.current?.links) && work.rows.length === 0;
  const addRow = active && !ticket.trashed && (
    <div
      className="ticket-add-row"
      role="group"
      aria-label="Add to this ticket"
    >
      {noSubtickets && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => work.openLink("subticket")}
        >
          <Plus aria-hidden="true" />
          Subticket
        </Button>
      )}
      {noRelationships && (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Link a ticket"
          onClick={() => work.openLink("related")}
        >
          <Plus aria-hidden="true" />
          Link
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setEvidenceRequest((count) => count + 1)}
      >
        <Plus aria-hidden="true" />
        Evidence
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={setFileAddTarget} variant="ghost" size="sm">
            <Plus aria-hidden="true" />
            File
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() =>
              setFileAddRequest({ kind: "file", key: Date.now() })
            }
          >
            File…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              setFileAddRequest({ kind: "document", key: Date.now() })
            }
          >
            Document…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  const ticketRuns = useTicketRuns(ticket.reference, active);
  // Pages stay mounted while hidden and the shared scrollers keep their
  // offset, so showing a ticket starts its document at the top.
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = page.current;
    if (!active || !content) return;
    for (const node of [
      content.parentElement,
      content,
      content.querySelector(".detail-document"),
    ]) {
      if (node) node.scrollTop = 0;
    }
  }, [active]);
  // The reading column: title, state, description, subtickets, evidence,
  // backlinks, then notes and history.
  const source = externalSource(ticket);
  const issueReference = source ? sourceReference(source) : null;
  const state = source ? sourceState(source) : null;
  const original =
    source?.state.category === "duplicate" &&
    !source.unavailable &&
    source.duplicate_target?.kind === "external"
      ? source.duplicate_target
      : null;
  const originalLabel =
    (issueReference?.place ? source?.duplicate_number : undefined) ??
    original?.display;
  // The header owns the normal updated time. Only source or exceptional
  // context needs a line between the property strip and the description.
  const stateLine =
    source || sourcesConfigured || ticket.source || outsideResults ? (
      <p className="ticket-state-line">
        {source && state ? (
          <>
            <span className="ticket-source-state">
              {state.tone && <StatusDot tone={state.tone} size={10} />}
              <span>{state.text}</span>
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
                {source.state.category === "open" && (
                  <span>{issueReference?.label}</span>
                )}
                {original && (
                  <span>
                    Duplicate of{" "}
                    <Tooltip content={original.display} side="bottom">
                      <span className="source-number" tabIndex={0}>
                        {originalLabel}
                      </span>
                    </Tooltip>
                    {original.last_known && " (last known)"}
                  </span>
                )}
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
            {/* Part of the last synced copy, so shown while the source is unavailable too. */}
            {source.author && <span>{source.author}</span>}
            {source.created_at && (
              <Tooltip
                content={formatDateTime(source.created_at)}
                side="bottom"
              >
                <time dateTime={source.created_at} tabIndex={0}>
                  opened {relativeDateTime(source.created_at, now)}
                </time>
              </Tooltip>
            )}
          </>
        ) : sourcesConfigured || ticket.source ? (
          <span>Local ticket</span>
        ) : null}
        {outsideResults && <span>Not in the current results</span>}
      </p>
    ) : null;
  // The source owns the title and description, so they are read, never edited.
  const contentLocked = Boolean(source?.content_locked);
  const attentionFor = (variant: "rail" | "strip") =>
    active &&
    !ticket.trashed && (
      <>
        <Reminder
          key={`reminder-${ticket.reference}`}
          variant={variant}
          projects={projects}
          plans={plans}
        />
      </>
    );
  const files = active && (
    <TicketFiles
      key={ticket.reference}
      onOpenUpdate={(id) => setUpdateTarget({ id, key: Date.now() })}
      expanded={expanded}
      addRequest={fileAddRequest}
      hideEmpty
      addTrigger={fileAddTarget}
    />
  );
  const relationships = active && (
    <LinkedWork work={work} select={select} onOpenGraph={onOpenGraph} document>
      <Backlinks select={onMention} />
    </LinkedWork>
  );
  const runs = active && <TicketRunsSection runs={ticketRuns.runs} />;
  // One property strip for every document width.
  const [reminderOpen, setReminderOpen] = useState(false);
  const blockedReferences = work.current?.links
    ? work.rows
        .filter((row) => row.kind === "blocked_by" && row.unresolved)
        .map((row) => row.reference)
    : ticket.prerequisites
        .filter((item) => item.unresolved && !item.trashed)
        .map((item) => item.reference);
  const strip = (
    <TicketProperties
      layout="strip"
      attention={attentionFor("strip")}
      ticket={ticket}
      active={active && !opening}
      projects={projects}
      plans={plans}
      onSaved={changed}
      refresh={changed}
      onOpenTicket={select}
      onOpenNote={(id) => setUpdateTarget({ id, key: Date.now() })}
    >
      {active && !ticket.trashed && (
        <>
          {blockedReferences.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => work.openLink("blocked_by")}
            >
              <Plus aria-hidden="true" />
              Blocked by {blockedReferences.join(", ")}
            </Button>
          )}
          <TicketCommandPicker
            ticket={ticket}
            projects={projects}
            plans={plans}
            refresh={changed}
            scope="Reminder"
            open={reminderOpen}
            onOpenChange={setReminderOpen}
            anchorOnly
            trigger={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label="Add ticket property" size="icon-compact">
                    <Plus />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => {
                    if (reminderOpen) event.preventDefault();
                  }}
                >
                  {openCommand && (
                    <DropdownMenuItem onSelect={() => setReminderOpen(true)}>
                      Reminder
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => work.openLink("blocked_by")}
                  >
                    Blocked by
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => work.openLink("parent")}>
                    Parent
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => work.openLink("related")}>
                    Link
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        </>
      )}
    </TicketProperties>
  );
  return (
    <div
      ref={page}
      className="detail-content"
      hidden={!active && !leaving}
      inert={opening || leaving}
      aria-busy={opening}
      data-swap={swap || undefined}
      data-fresh={fresh || undefined}
      data-leaving={leaving || undefined}
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
          <SourceUnavailableNotice ticket={ticket} refresh={changed} />
        )}
        {active && <PublicationNotice ticket={ticket} refresh={changed} />}
        {active && <RunNotices {...ticketRuns} />}
        {ticket.trashed || contentLocked ? (
          <>
            {source && contentLocked ? (
              <ReadOnlyTitle title={ticket.title} source={source} />
            ) : (
              <h3 className="detail-title">{ticket.title}</h3>
            )}
            {strip}
            {stateLine}
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
            readOnly={opening}
            onSaved={changed}
            select={select}
            revision={revision}
            mention={mention}
            stateLine={stateLine}
          >
            {strip}
          </TicketEditor>
        )}
        {addRow}
        <RailPlacement value="column">
          <div className="detail-connected">{relationships}</div>
        </RailPlacement>
        {active && (
          <Evidence
            trashed={ticket.trashed}
            folded
            addRequest={evidenceRequest}
          />
        )}
        {
          <RailPlacement value="column">
            <div className="detail-connected">
              {runs}
              {files}
            </div>
          </RailPlacement>
        }
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
          active={active}
          trashed={ticket.trashed}
          select={select}
          foldEmpty
          latestNoteId={ticket.latest_update?.activity_id}
          sourceName={source?.provider_name}
        />
      </div>
    </div>
  );
}
