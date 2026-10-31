import { Follow } from "@/features/tickets/Inbox";
import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Maximize2, X } from "lucide-react";
import { type Project, type Ticket } from "@/lib/api/client";
import { Backlinks } from "@/features/tickets/Backlinks";
import { Hierarchy } from "@/features/tickets/Hierarchy";
import { TicketProperties } from "@/features/tickets/TicketProperties";
import type { Effort } from "@/lib/api/efforts";
import { Dependencies } from "@/features/tickets/Dependencies";
import { Activity } from "@/features/tickets/Activity";
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
  return (
    <section className="ticket-detail" aria-labelledby="detail-heading">
      <div className="detail-header">
        <h2 id="detail-heading" tabIndex={-1}>
          Ticket details
        </h2>
        {selected && (
          <div className="detail-actions">
            <button
              className="icon-button return-to-list"
              aria-label="Return to ticket list"
              onClick={onReturn}
            >
              <ArrowLeft size={16} />
            </button>
            {!expanded && (
              <button
                className="icon-button expand-ticket"
                aria-label="Expand ticket"
                onClick={onExpand}
              >
                <Maximize2 size={16} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Close ticket details"
              onClick={() => setSelected(null)}
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
      {selected === null && (
        <p className="mt-3">Select a ticket to see its details.</p>
      )}
      {Object.values(details).map((item) => (
        <div
          className="detail-content"
          key={item.id}
          hidden={item.reference !== selected}
        >
          {item.reference === selected && (
            <Follow reference={item.reference} revision={revision} />
          )}
          {item.trashed ? (
            <>
              <h3>
                {item.reference} · {item.title}
              </h3>
              <TicketProperties
                ticket={item}
                projects={projects}
                efforts={efforts}
                onSaved={updateTicket}
                refresh={refresh}
              />
            </>
          ) : (
            <TicketEditor
              ticket={item}
              onSaved={updateTicket}
              select={setSelected}
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
            <>
              <details className="detail-disclosure">
                <summary>Relationships</summary>
                {graphReference === item.reference ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGraphReference(null)}
                    >
                      Back to relationships
                    </Button>
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
                  </>
                ) : (
                  <>
                    <Hierarchy
                      ticket={item}
                      refresh={refresh}
                      revision={revision}
                      select={(reference) => {
                        setSelected(reference);
                      }}
                    />
                    <Dependencies
                      ticket={item}
                      refresh={refresh}
                      select={(reference) => {
                        setSelected(reference);
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGraphReference(item.reference)}
                    >
                      Open dependency graph
                    </Button>
                  </>
                )}
              </details>
            </>
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
