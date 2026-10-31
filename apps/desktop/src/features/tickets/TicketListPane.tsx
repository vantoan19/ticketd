import type { RefObject } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulkControls } from "@/features/tickets/BulkControls";
import { TicketFilters } from "@/features/tickets/TicketFilters";
import { TicketList } from "@/features/tickets/TicketList";
import { TicketRowsSkeleton } from "@/features/tickets/TicketRowsSkeleton";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";

const PAGE_SIZE = 50;

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
  onCreate: (trigger: HTMLButtonElement) => void;
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
    selected,
    loading,
    refresh,
    scopeName,
    navigation,
    clearFilters,
    queryError,
  } = workspace;
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
  const showBulk =
    !trash &&
    (bulk.selection.length > 0 || bulk.failure || bulk.notice || bulk.pending);
  return (
    <section
      className="ticket-list"
      ref={listRef}
      aria-labelledby="tickets-heading"
    >
      <div className="list-header">
        <h1 id="tickets-heading" tabIndex={-1}>
          {scopeName}
        </h1>
        <p>
          {tickets.length} {tickets.length === 1 ? "ticket" : "tickets"}
          {tickets.length === PAGE_SIZE ? " shown" : ""}
        </p>
        <Button
          className="list-refresh"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh"
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </Button>
      </div>
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
        <TicketList
          tickets={visibleTickets}
          scope={{
            showEffort: !navigation.effort,
            showProject: navigation.project === "all",
            efforts,
            projects,
          }}
          selected={selected}
          selectable={!trash}
          selectionDisabled={bulk.pending}
          bulkSelection={bulk.selection}
          onToggle={bulk.toggle}
          onOpen={onOpen}
        />
      )}
      {!trash && (offset > 0 || tickets.length === PAGE_SIZE) && (
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
          <span> Page {Math.floor(offset / PAGE_SIZE) + 1} </span>
          <button
            type="button"
            disabled={tickets.length < PAGE_SIZE}
            onClick={() => {
              setOffset(offset + PAGE_SIZE);
            }}
          >
            Next
          </button>
        </div>
      )}
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
