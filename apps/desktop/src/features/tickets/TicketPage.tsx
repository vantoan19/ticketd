import { Alert, AlertActions, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLayoutEffect, useRef, useState } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Evidence } from "@/features/tickets/Evidence";
import type { MentionTarget } from "@/features/tickets/Backlinks";
import { RailPlacement } from "@/features/tickets/rail-placement";
import { TicketClosingLine, TicketParentLine } from "./TicketPageLines";
import { TicketContextLine } from "./TicketContextLine";
import { TicketAgentStrip } from "./TicketAgent";
import {
  LinkedWork,
  LinkedWorkDialogs,
  type LinkedWorkHandle,
} from "@/features/tickets/LinkedWork";
import {
  TicketFiles,
  type FileAddRequest,
} from "@/features/tickets/TicketFiles";
import { useLinkedWork } from "@/features/tickets/useLinkedWork";
import { Activity } from "@/features/tickets/Activity";
import { SourceConversation } from "@/features/tickets/SourceConversation";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { ReadOnlyTitle, SourceDescription } from "./ReadOnlySource";
import { SourceUnavailableNotice } from "@/features/tickets/SourceUnavailableNotice";
import { NeedsReviewNotice } from "@/features/sync-review/NeedsReviewNotice";
import {
  RunNotices,
  TicketRunsSection,
} from "@/features/automations/TicketRuns";
import { useTicketRuns } from "@/features/automations/use-ticket-runs";
import { PublicationNotice } from "@/features/tickets/PublishToSource";
import { externalSource } from "@/features/tickets/ticket-source";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import { useTicketTrash } from "@/features/tickets/use-ticket-trash";
import type { Project } from "@/lib/api/client";
import { useOpenTicket } from "./open-ticket";
import { useWorkspaceChange } from "@/lib/workspace-change";
import type { Plan } from "@/lib/api/plans";

type NoteTarget = { id: string; key: number };

/** The ticket document with its context line and linked work. */
export function TicketPage({
  active,
  expanded = false,
  swap = false,
  leaving = false,
  projects,
  plans,
  select,
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
  projects: Project[];
  plans: Plan[];
  select: (reference: string | null) => void;
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
  const [updateTarget, setUpdateTarget] = useState<NoteTarget | null>(null);
  const work = useLinkedWork();
  const trash = useTicketTrash(changed);
  const [evidenceRequest, setEvidenceRequest] = useState(0);
  const [fileAddRequest, setFileAddRequest] = useState<FileAddRequest | null>(
    null,
  );
  const [addTrigger, setAddTrigger] = useState<HTMLButtonElement | null>(null);
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
  const source = externalSource(ticket);
  // The source owns the title and description, so they are read, never edited.
  const contentLocked = Boolean(source?.content_locked);
  const linked = useRef<HTMLDivElement>(null);
  const linkedWork = useRef<LinkedWorkHandle>(null);
  const parentRow = work.rows.find((row) => row.kind === "parent");
  const parent = work.current?.links ? parentRow : ticket.parent;
  const files = active && (
    <TicketFiles
      key={ticket.reference}
      onOpenUpdate={(id) => setUpdateTarget({ id, key: Date.now() })}
      expanded={expanded}
      addRequest={fileAddRequest}
      hideEmpty
      addTrigger={addTrigger}
    />
  );
  const relationships = active && (
    <LinkedWork
      ref={linkedWork}
      work={work}
      select={select}
      onMention={onMention}
    />
  );
  const runs = active && <TicketRunsSection runs={ticketRuns.runs} />;
  const context = (
    <>
      <TicketContextLine
        projects={projects}
        plans={plans}
        work={work}
        select={select}
        addTriggerRef={setAddTrigger}
        additionalActions={
          <>
            <DropdownMenuItem
              onSelect={() => setEvidenceRequest((count) => count + 1)}
            >
              Evidence…
            </DropdownMenuItem>
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
          </>
        }
        onOpenSubtickets={() => {
          linkedWork.current?.openSubtickets();
          linked.current?.scrollIntoView({ block: "start" });
        }}
      />
      {ticket.status === "Done" ? (
        <TicketClosingLine />
      ) : (
        <TicketAgentStrip
          reference={ticket.reference}
          onOpenUpdate={(id) => setUpdateTarget({ id, key: Date.now() })}
        />
      )}
    </>
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
        {parent && (
          <TicketParentLine
            parent={parent}
            select={select}
            {...(parentRow &&
              !ticket.trashed &&
              !work.pending && { onRemove: () => void work.remove(parentRow) })}
          />
        )}
        {ticket.trashed || contentLocked ? (
          <>
            {source && contentLocked ? (
              <ReadOnlyTitle title={ticket.title} source={source} />
            ) : (
              <h1 className="detail-title">{ticket.title}</h1>
            )}
            {context}
            <div className="editor-body">
              {source && contentLocked ? (
                <SourceDescription
                  ticket={ticket}
                  source={source}
                  select={select}
                  revision={revision}
                  refresh={changed}
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
          >
            {context}
          </TicketEditor>
        )}
        <RailPlacement value="column">
          <div ref={linked} className="detail-connected">
            {relationships}
          </div>
        </RailPlacement>
        {active && (
          <Evidence
            trashed={ticket.trashed}
            folded
            addRequest={evidenceRequest}
            addTrigger={addTrigger}
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
