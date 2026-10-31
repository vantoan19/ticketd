import { lazy, Suspense } from "react";
import { ArrowLeft, Maximize2, X } from "lucide-react";
import { client, type Project, type Ticket } from "@/lib/api/client";
import { Hierarchy } from "@/features/tickets/Hierarchy";
import { TicketProject } from "@/features/projects/Projects";
import { Dependencies } from "@/features/tickets/Dependencies";
import { Notes } from "@/features/tickets/Notes";
import { History, StatusControl } from "@/features/tickets/History";
import { Tags } from "@/features/tickets/Tags";
import { TicketEditor } from "@/features/tickets/TicketEditor";
const DependencyGraph = lazy(
  () => import("@/features/tickets/DependencyGraph"),
);
export function TicketDetails({
  selected,
  expanded,
  onExpand,
  onReturn,
  setSelected,
  details,
  projects,
  revision,
  refresh,
  updateTicket,
  setError,
  setTrash,
}: {
  selected: string | null;
  expanded: boolean;
  onExpand: () => void;
  onReturn: () => void;
  setSelected: (value: string | null) => void;
  details: Record<string, Ticket>;
  projects: Project[];
  revision: number;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
  setError: (error: string) => void;
  setTrash: (trash: boolean) => void;
}) {
  return (
    <section className="ticket-detail" aria-labelledby="detail-heading">
      <div className="detail-header">
        <h2 id="detail-heading">Ticket details</h2>
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
          {item.trashed ? (
            <div className="detail-metadata">
              {item.reference === selected && (
                <StatusControl
                  reference={item.reference}
                  status={item.status}
                  trashed={item.trashed}
                  onChange={refresh}
                />
              )}
              {!item.trashed && (
                <TicketProject
                  ticket={item}
                  projects={projects}
                  onSaved={updateTicket}
                />
              )}
              <button
                type="button"
                onClick={() =>
                  void client
                    .setTrashed(item.reference, !item.trashed)
                    .then(refresh)
                    .catch((reason: unknown) => setError(String(reason)))
                }
              >
                {item.trashed ? "Restore" : "Move to trash"}
              </button>
            </div>
          ) : (
            <TicketEditor ticket={item} onSaved={updateTicket}>
              <div className="detail-metadata">
                {item.reference === selected && (
                  <StatusControl
                    reference={item.reference}
                    status={item.status}
                    trashed={item.trashed}
                    onChange={refresh}
                  />
                )}
                {!item.trashed && (
                  <TicketProject
                    ticket={item}
                    projects={projects}
                    onSaved={updateTicket}
                  />
                )}
                <button
                  type="button"
                  onClick={() =>
                    void client
                      .setTrashed(item.reference, !item.trashed)
                      .then(refresh)
                      .catch((reason: unknown) => setError(String(reason)))
                  }
                >
                  {item.trashed ? "Restore" : "Move to trash"}
                </button>
              </div>
            </TicketEditor>
          )}
          {item.reference === selected && !item.trashed && (
            <>
              <details className="detail-disclosure">
                <summary>Relationships & graph</summary>
                <Hierarchy
                  ticket={item}
                  refresh={refresh}
                  select={setSelected}
                />
                <Dependencies ticket={item} refresh={refresh} />
                <Suspense fallback={<p>Loading graph…</p>}>
                  <DependencyGraph
                    key={item.reference}
                    reference={item.reference}
                    revision={revision}
                    select={(reference, trashed) => {
                      setSelected(reference);
                      setTrash(trashed);
                    }}
                  />
                </Suspense>
              </details>
            </>
          )}
          {item.reference === selected && (
            <History
              reference={item.reference}
              projects={projects}
              status={item.status}
              revision={revision}
            />
          )}
          {!item.trashed && (
            <details className="detail-disclosure">
              <summary>Notes</summary>
              <Notes reference={item.reference} refreshRevision={revision} />
            </details>
          )}
          {!item.trashed && (
            <details className="detail-disclosure">
              <summary>Tags</summary>
              <Tags
                reference={item.reference}
                tags={item.tags}
                refresh={refresh}
              />
            </details>
          )}
        </div>
      ))}
    </section>
  );
}
