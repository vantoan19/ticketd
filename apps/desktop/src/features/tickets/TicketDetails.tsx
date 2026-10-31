import { TicketHeader } from "@/features/tickets/TicketHeader";
import { Evidence } from "@/features/tickets/Evidence";
import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Project, type Ticket } from "@/lib/api/client";
import { Backlinks } from "@/features/tickets/Backlinks";
import { Hierarchy } from "@/features/tickets/Hierarchy";
import { TicketProperties } from "@/features/tickets/TicketProperties";
import type { Effort } from "@/lib/api/efforts";
import { ContextualRelationships } from "@/features/tickets/ContextualRelationships";
import { Duplicates } from "@/features/tickets/Duplicates";
import { Dependencies } from "@/features/tickets/Dependencies";
import { Activity } from "@/features/tickets/Activity";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { TicketEditor } from "@/features/tickets/TicketEditor";
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
  const ticket = Object.values(details).find(
    (item) => item.reference === selected,
  );
  return (
    <section
      className="ticket-detail"
      data-expanded={expanded || undefined}
      aria-labelledby="detail-heading"
    >
      <TicketHeader
        selected={selected}
        ticket={ticket}
        expanded={expanded}
        revision={revision}
        onExpand={onExpand}
        onReturn={onReturn}
        onClose={() => setSelected(null)}
        onOpenGraph={() => {
          if (!selected) return;
          setGraphReference(selected);
          window.requestAnimationFrame(() =>
            document
              .getElementById(`relationships-${selected}`)
              ?.scrollIntoView?.({ block: "start" }),
          );
        }}
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
          {item.duplicate_of && (
            <p>
              Duplicate of{" "}
              <Button
                variant="link"
                onClick={() => setSelected(item.duplicate_of ?? null)}
              >
                {item.duplicate_of}
              </Button>
            </p>
          )}
          {item.reference === selected && !item.trashed && (
            <section
              id={`relationships-${item.reference}`}
              className="relationships"
              aria-label="Relationships"
            >
              <div className="detail-section-heading">
                <h3>Relationships</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setGraphReference(
                      graphReference === item.reference ? null : item.reference,
                    )
                  }
                >
                  {graphReference === item.reference
                    ? "Back to relationships"
                    : "Open dependency graph"}
                </Button>
              </div>
              {graphReference === item.reference ? (
                <Suspense fallback={<p role="status">Loading graph…</p>}>
                  <DependencyGraph
                    key={item.reference}
                    reference={item.reference}
                    revision={revision}
                    select={(reference) => {
                      setSelected(reference);
                      setGraphReference(null);
                    }}
                  />
                </Suspense>
              ) : (
                <div className="relationships-grid">
                  <details className="detail-disclosure">
                    <summary aria-label="Related work">Related work</summary>
                    <ContextualRelationships
                      key={item.reference}
                      ticket={item}
                      refresh={refresh}
                      revision={revision}
                      select={setSelected}
                    />
                  </details>
                  <details className="detail-disclosure">
                    <summary aria-label="Duplicates">
                      Duplicates
                      {!!(item.duplicate_of || item.duplicates?.length) && (
                        <span>{item.duplicates?.length || 1}</span>
                      )}
                    </summary>
                    <Duplicates
                      ticket={item}
                      refresh={refresh}
                      select={setSelected}
                    />
                  </details>
                  <details className="detail-disclosure">
                    <summary aria-label="Parent and subtickets">
                      Parent and subtickets
                      {!!(item.parent || item.children.length) && (
                        <span>
                          {item.children.length + (item.parent ? 1 : 0)}
                        </span>
                      )}
                    </summary>
                    <Hierarchy
                      ticket={item}
                      refresh={refresh}
                      revision={revision}
                      select={(reference) => {
                        setSelected(reference);
                      }}
                    />
                  </details>
                  <details
                    className="detail-disclosure"
                    open={item.prerequisites.length > 0 || undefined}
                  >
                    <summary aria-label="Blocking dependencies">
                      Blocking dependencies
                      {item.prerequisites.length > 0 && (
                        <span>{item.prerequisites.length}</span>
                      )}
                    </summary>
                    <Dependencies
                      ticket={item}
                      refresh={refresh}
                      select={(reference) => {
                        setSelected(reference);
                      }}
                    />
                  </details>
                </div>
              )}
            </section>
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
              select={setSelected}
            />
          )}
          <Activity
            reference={item.reference}
            target={
              inboxTarget?.reference === item.reference ? inboxTarget : null
            }
            projects={projects}
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
