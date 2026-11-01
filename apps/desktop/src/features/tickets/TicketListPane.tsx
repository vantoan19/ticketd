import { useEffect, useRef, useState, type RefObject } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { EffortHeader } from "@/features/efforts/EffortHeader";
import { useEffortView } from "@/features/efforts/useEffortView";
import { effortsClient } from "@/lib/api/efforts";
import { BulkControls } from "@/features/tickets/BulkControls";
import { MarkDuplicateDialog } from "@/features/tickets/MarkDuplicateDialog";
import { TicketFilters } from "@/features/tickets/TicketFilters";
import { TicketList } from "@/features/tickets/TicketList";
import { TicketRowsSkeleton } from "@/features/tickets/TicketRowsSkeleton";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { Ticket } from "@/lib/api/client";
import {
  PAGE_SIZE,
  type TicketWorkspace,
} from "@/features/tickets/useTicketWorkspace";

/** The list header, filters, bulk editing, result states, and pagination. */
export function TicketListPane({
  workspace,
  bulk,
  listRef,
  onOpen,
  onCreate,
}: {
  workspace: TicketWorkspace;
  bulk: BulkEdit;
  listRef: RefObject<HTMLElement | null>;
  onOpen: (reference: string) => void;
  onCreate: (trigger: HTMLButtonElement, status?: string) => void;
}) {
  const {
    projects,
    efforts,
    filter,
    query,
    setQuery,
    offset,
    setOffset,
    effort,
    setEffort,
    status,
    setStatus,
    tags,
    setTags,
    availability,
    setAvailability,
    family,
    setFamily,
    trash,
    tickets,
    counts,
    total,
    grouped,
    selected,
    loading,
    refresh,
    scopeName,
    navigation,
    clearFilters,
    queryError,
    revision,
  } = workspace;
  // An Effort scope shows the Effort's own header instead of a plain title.
  const [markingDuplicate, setMarkingDuplicate] = useState(false);
  const effortScope = !trash && navigation.effort ? navigation.effort : "";
  const scopedEffort = efforts.find((item) => item.id === effortScope);
  const effortState = useEffortView(effortScope, revision, refresh);
  const filtered =
    navigation.effort !== effort ||
    status !== (navigation.kind === "progress" ? "In progress" : "") ||
    availability !== (navigation.kind === "ready" ? "Ready" : "") ||
    Boolean(query || tags || family);
  const visibleTickets = tickets.filter(
    (item) =>
      filter === "all" ||
      (filter === "unlinked"
        ? item.project_id === null
        : item.project_id === filter),
  );
  // A selection belongs to the page it was made on. Moving to another page,
  // scope, search or filter drops it, so the bar never acts on tickets that are
  // no longer listed.
  const viewKey = JSON.stringify([
    offset,
    filter,
    query,
    effort,
    status,
    tags,
    availability,
    family,
    trash,
    navigation,
  ]);
  const previousView = useRef(viewKey);
  const { clearSelection } = bulk;
  useEffect(() => {
    if (previousView.current === viewKey) return;
    previousView.current = viewKey;
    clearSelection();
  }, [viewKey, clearSelection]);
  const showBulk =
    !trash &&
    (bulk.selection.length > 0 || bulk.failure || bulk.notice || bulk.pending);
  return (
    <section
      className="ticket-list"
      ref={listRef}
      aria-labelledby="tickets-heading"
    >
      {scopedEffort ? (
        <EffortHeader
          effort={scopedEffort}
          efforts={efforts}
          projects={projects}
          state={effortState}
        />
      ) : (
        <div className="list-header">
          <h1 id="tickets-heading" tabIndex={-1}>
            {scopeName}
          </h1>
          <p>
            {total} {total === 1 ? "ticket" : "tickets"}
          </p>
          <IconButton
            className="list-refresh"
            label="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </IconButton>
        </div>
      )}
      {!trash && (
        <TicketFilters
          {...{
            query,
            setQuery,
            effort,
            setEffort,
            status,
            setStatus,
            tags,
            setTags,
            availability,
            setAvailability,
            family,
            setFamily,
            efforts,
            setOffset,
            navigation,
            clearFilters,
          }}
        />
      )}

      {queryError ? (
        <div className="empty-state" role="alert">
          <strong>Could not load tickets</strong>
          <p>Try refreshing the current view.</p>
          <Button variant="outline" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : loading && tickets.length === 0 ? (
        <TicketRowsSkeleton />
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          {trash ? (
            <p>No tickets in trash.</p>
          ) : filtered ? (
            <>
              <strong>No matching tickets</strong>
              {query ? (
                <p>
                  Nothing matches <q>{query}</q>
                  {tags || status || availability || family || effort
                    ? " with the current filters"
                    : ""}
                  .
                </p>
              ) : (
                <p>Nothing matches the current filters.</p>
              )}
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            </>
          ) : effortScope ? (
            <>
              <strong>No tickets in this Effort</strong>
              <p>Use Add tickets to bring existing tickets into it.</p>
            </>
          ) : navigation.project !== "all" ||
            navigation.effort ||
            navigation.kind !== "all" ? (
            <>
              <strong>No tickets in this scope</strong>
              <p>Create a ticket or choose another view.</p>
              <Button
                variant="outline"
                onClick={(event) => onCreate(event.currentTarget)}
              >
                Create ticket
              </Button>
            </>
          ) : (
            <>
              <strong>Your workspace is ready</strong>
              <p>Create your first ticket to start keeping track of work.</p>
              <Button onClick={(event) => onCreate(event.currentTarget)}>
                <Plus data-icon="inline-start" /> Create your first ticket
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          {showBulk && bulk.selection.length > 0 && (
            // The bar is last in the page but is the next thing to reach.
            <a
              className="skip-link"
              href="#bulk-controls"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById("bulk-controls")?.focus();
              }}
            >
              Skip to selection actions
            </a>
          )}
          <TicketList
            tickets={visibleTickets}
            scope={{
              showEffort: !navigation.effort,
              showProject: navigation.project === "all",
              efforts,
              projects,
            }}
            selected={selected}
            {...(grouped &&
              counts && {
                grouping: {
                  counts,
                  onAdd: (status: string, trigger: HTMLButtonElement) => {
                    if (status === "Duplicate") setMarkingDuplicate(true);
                    else onCreate(trigger, status);
                  },
                },
              })}
            selectable={!trash}
            selectionDisabled={bulk.pending}
            bulkSelection={bulk.selection}
            onToggle={bulk.toggle}
            onOpen={onOpen}
            {...(scopedEffort && {
              rowAction: (ticket: Ticket) => (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={effortState.pending}
                  aria-label={`Remove ${ticket.reference} from ${scopedEffort.name}`}
                  title="Remove from Effort"
                  onClick={() =>
                    void effortState.run(() =>
                      effortsClient.setMember(ticket.reference, null),
                    )
                  }
                >
                  <X />
                </Button>
              ),
            })}
          />
        </>
      )}
      {!trash && total > PAGE_SIZE && (
        <div className="pagination">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE_SIZE));
            }}
          >
            Previous
          </button>
          <span>
            {" "}
            Showing {offset + 1}–{offset + tickets.length} of {total}{" "}
          </span>
          <button
            type="button"
            disabled={offset + tickets.length >= total}
            onClick={() => {
              setOffset(offset + PAGE_SIZE);
            }}
          >
            Next
          </button>
        </div>
      )}
      <MarkDuplicateDialog
        open={markingDuplicate}
        onOpenChange={setMarkingDuplicate}
        refresh={refresh}
      />
      {showBulk && (
        <BulkControls
          bulk={bulk}
          visible={visibleTickets}
          projects={projects}
          efforts={efforts}
        />
      )}
    </section>
  );
}
