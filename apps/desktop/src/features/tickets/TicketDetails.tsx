import { TicketHeader } from "@/features/tickets/TicketHeader";
import { Evidence } from "@/features/tickets/Evidence";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { type Project, type Ticket } from "@/lib/api/client";
import { Backlinks, type MentionTarget } from "@/features/tickets/Backlinks";
import { TicketProperties } from "@/features/tickets/TicketProperties";
import type { Effort } from "@/lib/api/efforts";
import { LinkedWork } from "@/features/tickets/LinkedWork";
import { Activity } from "@/features/tickets/Activity";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { TicketEditor } from "@/features/tickets/TicketEditor";
type NoteTarget = { id: string; key: number };

/** Two ways to arrive at a note (the Inbox, a backlink); the later one wins. */
function newest(
  first: NoteTarget | null,
  second: NoteTarget | null,
): NoteTarget | null {
  if (first && second) return second.key >= first.key ? second : first;
  return first ?? second;
}

const DependencyGraph = lazy(
  () => import("@/features/tickets/DependencyGraph"),
);
export function TicketDetails({
  selected,
  inboxTarget,
  expanded,
  onExpand,
  onReturn,
  setSelected,
  details,
  projects,
  efforts,
  revision,
  refresh,
  updateTicket,
}: {
  selected: string | null;
  inboxTarget?: { reference: string; id: string; key: number } | null;
  expanded: boolean;
  onExpand: () => void;
  onReturn: () => void;
  setSelected: (value: string | null) => void;
  details: Record<string, Ticket>;
  projects: Project[];
  efforts: Effort[];
  revision: number;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
}) {
  const [graphReference, setGraphReference] = useState<string | null>(null);
  // The graph belongs to the ticket it opened from; selecting another closes it.
  const graphOpen = graphReference !== null && graphReference === selected;
  // Closing the graph unmounts the control that had focus; land on the ticket heading.
  const returnFromGraph = useRef(false);
  useEffect(() => {
    if (!graphOpen && returnFromGraph.current) {
      returnFromGraph.current = false;
      document.getElementById("detail-heading")?.focus();
    }
  }, [graphOpen]);
  const closeGraph = () => {
    returnFromGraph.current = true;
    setGraphReference(null);
  };
  const [mention, setMention] = useState<
    (MentionTarget & { key: number }) | null
  >(null);
  const ticket = Object.values(details).find(
    (item) => item.reference === selected,
  );
  return (
    <section
      className="ticket-detail"
      data-expanded={expanded || undefined}
      data-graph={graphOpen || undefined}
      aria-labelledby="detail-heading"
    >
      {graphOpen && selected && (
        <Suspense fallback={<p role="status">Loading graph…</p>}>
          <DependencyGraph
            key={selected}
            reference={selected}
            revision={revision}
            projects={projects}
            efforts={efforts}
            onBack={closeGraph}
            onOpen={(reference) => {
              closeGraph();
              setSelected(reference);
            }}
          />
        </Suspense>
      )}
      <TicketHeader
        selected={selected}
        ticket={ticket}
        expanded={expanded}
        revision={revision}
        onExpand={onExpand}
        onReturn={onReturn}
        onClose={() => setSelected(null)}
        onOpenGraph={() => setGraphReference(selected)}
        select={setSelected}
        refresh={refresh}
        updateTicket={updateTicket}
      />
      {selected === null && (
        <div className="detail-empty">
          <strong>Select a ticket</strong>
          <p>Read its description, links, and activity here.</p>
        </div>
      )}
      {Object.values(details).map((item) => (
        <div
          className="detail-content"
          key={item.id}
          hidden={item.reference !== selected}
        >
          {item.trashed ? (
            <>
              <h3>{item.title}</h3>
              <TicketProperties
                ticket={item}
                projects={projects}
                efforts={efforts}
                onSaved={updateTicket}
                refresh={refresh}
              />
              <div className="editor-body">
                <p className="description-heading">Description</p>
                <div className="markdown-preview description-document">
                  <MarkdownDocument
                    source={item.body}
                    select={setSelected}
                    revision={revision}
                  />
                </div>
              </div>
            </>
          ) : (
            <TicketEditor
              ticket={item}
              onSaved={updateTicket}
              select={setSelected}
              revision={revision}
            >
              <TicketProperties
                ticket={item}
                projects={projects}
                efforts={efforts}
                onSaved={updateTicket}
                refresh={refresh}
              />
            </TicketEditor>
          )}
          {item.reference === selected && !item.trashed && (
            <LinkedWork
              ticket={item}
              revision={revision}
              refresh={refresh}
              select={setSelected}
              onOpenGraph={() => setGraphReference(item.reference)}
            />
          )}
          {item.reference === selected && (
            <Evidence
              reference={item.reference}
              revision={revision}
              trashed={item.trashed}
              refresh={refresh}
            />
          )}
          {item.reference === selected && (
            <Backlinks
              reference={item.reference}
              revision={revision}
              select={(target) => {
                setMention({ ...target, key: Date.now() });
                setSelected(target.reference);
              }}
            />
          )}
          <Activity
            reference={item.reference}
            target={newest(
              inboxTarget?.reference === item.reference ? inboxTarget : null,
              mention?.reference === item.reference && mention.noteId
                ? { id: mention.noteId, key: mention.key }
                : null,
            )}
            mention={
              mention?.reference === item.reference && !mention.noteId
                ? mention
                : null
            }
            projects={projects}
            efforts={efforts}
            status={item.status}
            revision={revision}
            active={item.reference === selected}
            trashed={item.trashed}
            select={setSelected}
          />
        </div>
      ))}
    </section>
  );
}
