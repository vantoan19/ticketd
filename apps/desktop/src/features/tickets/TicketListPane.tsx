import { planSummary as summarizePlan } from "@/features/plans/plan-summary";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  AlertCircle,
  Layers,
  Plus,
  RefreshCw,
  SearchX,
  Ticket as TicketIcon,
  Trash2,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { PlanViewState } from "@/features/plans/usePlanView";
import { plansClient } from "@/lib/api/plans";
import { BulkControls } from "@/features/tickets/BulkControls";
import { MarkDuplicateDialog } from "@/features/tickets/MarkDuplicateDialog";
import { TicketFilters } from "@/features/tickets/TicketFilters";
import { SourceFilter, SourceRefresh } from "@/features/tickets/SourceFilter";
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
  planState,
  onOpen,
  onCreate,
}: {
  workspace: TicketWorkspace;
  bulk: BulkEdit;
  listRef: RefObject<HTMLElement | null>;
  planState: PlanViewState;
  onOpen: (reference: string) => void;
  onCreate: (trigger: HTMLButtonElement, status?: string) => void;
}) {
  const {
    projects,
    plans,
    filter,
    query,
    setQuery,
    offset,
    setOffset,
    plan,
    setPlan,
    status,
    setStatus,
    tags,
    setTags,
    availability,
    setAvailability,
    family,
    setFamily,
    source,
    setSource,
    sourceCounts,
    configuredSources,
    sourceRefresh,
    refreshSources,
    trash,
    tickets,
    counts,
    scopeTotal,
    total,
    grouped,
    selected,
    loading,
    refresh,
    scopeName,
    navigation,
    clearFilters,
    queryError,
    refreshFailed,
  } = workspace;
  // An Plan scope shows the Plan's own header instead of a plain title.
  const [markingDuplicate, setMarkingDuplicate] = useState(false);
  const [removed, setRemoved] = useState<{
    reference: string;
    plan: string;
    name: string;
  } | null>(null);
  // The Undo offer is short-lived: it must not linger after the ticket is re-added.
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [removed]);
  const planScope = !trash && navigation.plan ? navigation.plan : "";
  const scopedPlan = plans.find((item) => item.id === planScope);
  // An archived Plan is read-only: no new tickets into it, no removing from it.
  const planWritable = scopedPlan !== undefined && !scopedPlan.archived;
  const addDisabled = scopedPlan?.archived === true;
  const filtered =
    navigation.plan !== plan ||
    status !== (navigation.kind === "progress" ? "In progress" : "") ||
    availability !== (navigation.kind === "ready" ? "Ready" : "") ||
    Boolean(query || tags || family) ||
    source !== "all";
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
    plan,
    status,
    tags,
    availability,
    family,
    source,
    trash,
    navigation,
  ]);
  const previousView = useRef(viewKey);
  // Pressing Previous or Next can disable that very button (the first or last
  // page). Focus then moves to the other button, or to the list, never to the
  // document root.
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const paged = useRef<"previous" | "next" | null>(null);
  useEffect(() => {
    const which = paged.current;
    if (!which || loading) return;
    const own = which === "previous" ? previousButton : nextButton;
    const other = which === "previous" ? nextButton : previousButton;
    if (!own.current?.disabled) return;
    paged.current = null;
    (other.current && !other.current.disabled
      ? other.current
      : listRef.current
    )?.focus();
  });
  const { clearSelection } = bulk;
  useEffect(() => {
    if (previousView.current === viewKey) return;
    previousView.current = viewKey;
    clearSelection();
  }, [viewKey, clearSelection]);
  const showBulk =
    !trash &&
    (bulk.selection.length > 0 || bulk.failure || bulk.notice || bulk.pending);
  const singleStatusNote =
    navigation.kind === "ready"
      ? "Todo tickets with nothing left to wait on."
      : navigation.kind === "progress"
        ? "Tickets someone is working on right now."
        : null;
  const filterProps = {
    query,
    setQuery,
    plan,
    setPlan,
    status,
    setStatus,
    tags,
    setTags,
    availability,
    setAvailability,
    family,
    setFamily,
    plans,
    setOffset,
    navigation,
    clearFilters,
    scopeName,
    total,
    scopeTotal,
  };
  const members = planState.view?.members ?? [];
  const planSummary = summarizePlan(members, projects);
  return (
    <section
      className="ticket-list"
      ref={listRef}
      tabIndex={-1}
      aria-labelledby="tickets-heading"
    >
      {scopedPlan ? (
        <div className="plan-list-toolbar">
          <p className="plan-list-summary">{planSummary}</p>
          <TicketFilters part="controls" labeledFilter {...filterProps} />
        </div>
      ) : (
        <div className="list-header">
          <h1 id="tickets-heading" tabIndex={-1}>
            {scopeName}
          </h1>
          <p>
            {filtered && scopeTotal !== undefined
              ? `${total} of ${scopeTotal}`
              : `${total} ${total === 1 ? "ticket" : "tickets"}`}
          </p>
          <IconButton
            className="list-refresh"
            label="Refresh"
            disabled={sourceRefresh.running}
            onClick={() =>
              void (configuredSources.length > 0 ? refreshSources() : refresh())
            }
          >
            <RefreshCw />
          </IconButton>
          {!trash && (
            <TicketFilters part="controls" labeledFilter {...filterProps} />
          )}
          {configuredSources.length > 0 && (
            <SourceRefresh
              providers={configuredSources}
              state={sourceRefresh}
              tickets={tickets}
            />
          )}
        </div>
      )}
      {singleStatusNote && (
        <p className="list-description">{singleStatusNote}</p>
      )}
      {removed && removed.plan === planScope && (
        <p className="plan-undo" role="status">
          Removed {removed.reference} from {removed.name}.{" "}
          <Button
            variant="ghost"
            size="sm"
            disabled={planState.pending}
            onClick={() =>
              void planState
                .run(() =>
                  plansClient.setMember(removed.reference, removed.plan),
                )
                .then(() => setRemoved(null))
            }
          >
            Undo
          </Button>
        </p>
      )}
      {
        <>
          {!trash && (configuredSources.length > 0 || source !== "all") && (
            <>
              <SourceFilter
                value={source}
                onChange={setSource}
                counts={sourceCounts}
                providers={configuredSources}
              />
            </>
          )}
          {!trash && <TicketFilters part="chips" {...filterProps} />}

          {refreshFailed && !queryError && (
            <p role="status" className="refresh-failed">
              Can’t refresh. Showing the last list.{" "}
              <Button variant="link" size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            </p>
          )}
          {queryError ? (
            <EmptyState
              role="alert"
              icon={<AlertCircle />}
              title="Could not load tickets"
              description="Try refreshing the current view."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                >
                  Retry
                </Button>
              }
            />
          ) : loading && tickets.length === 0 ? (
            <TicketRowsSkeleton />
          ) : tickets.length === 0 ? (
            trash ? (
              <EmptyState
                icon={<Trash2 />}
                title="Trash is empty"
                description="Trashed tickets wait here until you restore them."
              />
            ) : filtered ? (
              <EmptyState
                icon={<SearchX />}
                title="No matching tickets"
                description={
                  query
                    ? `Nothing matches “${query}” in ${scopeName}${
                        tags || status || availability || family || plan
                          ? " with the current filters"
                          : ""
                      }.`
                    : "Nothing matches the current filters."
                }
                action={
                  query || tags || status || availability || family || plan ? (
                    <div className="plan-empty-actions">
                      {query && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setQuery("");
                            setOffset(0);
                          }}
                        >
                          Clear search
                        </Button>
                      )}
                      {(tags || status || availability || family || plan) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={clearFilters}
                        >
                          Clear filters
                        </Button>
                      )}
                    </div>
                  ) : undefined
                }
              />
            ) : planScope ? (
              <EmptyState
                icon={<Layers />}
                title="No tickets in this Plan"
                description="Start with a new ticket, or bring in existing ones."
                action={
                  <div className="plan-empty-actions">
                    <Button
                      size="sm"
                      onClick={(event) => onCreate(event.currentTarget)}
                    >
                      <Plus data-icon="inline-start" /> Create ticket
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => planState.setAdding(true)}
                    >
                      Add existing tickets
                    </Button>
                  </div>
                }
              />
            ) : navigation.project !== "all" ||
              navigation.plan ||
              navigation.kind !== "all" ? (
              <EmptyState
                icon={<TicketIcon />}
                title="No tickets in this scope"
                description="Create a ticket or choose another view."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) => onCreate(event.currentTarget)}
                  >
                    Create ticket
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<TicketIcon />}
                title="Your workspace is ready"
                description="Create your first ticket to start keeping track of work."
                action={
                  <Button
                    size="sm"
                    onClick={(event) => onCreate(event.currentTarget)}
                  >
                    <Plus data-icon="inline-start" /> Create your first ticket
                  </Button>
                }
              />
            )
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
                  showPlan: !navigation.plan,
                  showProject: navigation.project === "all",
                  plans,
                  projects,
                }}
                selected={selected}
                singleStatus={
                  navigation.kind === "ready" || navigation.kind === "progress"
                }
                {...(grouped &&
                  counts && {
                    grouping: {
                      counts,
                      ...(!addDisabled && {
                        onAdd: (status: string, trigger: HTMLButtonElement) => {
                          if (status === "Duplicate") setMarkingDuplicate(true);
                          else onCreate(trigger, status);
                        },
                      }),
                    },
                  })}
                selectable={!trash}
                selectionDisabled={bulk.pending}
                bulkSelection={bulk.selection}
                onToggle={bulk.toggle}
                onOpen={onOpen}
                {...(scopedPlan &&
                  planWritable && {
                    rowAction: (ticket: Ticket) => (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={planState.pending}
                        aria-label={`Remove ${ticket.reference} from ${scopedPlan.name}`}
                        title="Remove from Plan"
                        onClick={() =>
                          void planState
                            .run(() =>
                              plansClient.setMember(ticket.reference, null),
                            )
                            .then((done) => {
                              if (done)
                                setRemoved({
                                  reference: ticket.reference,
                                  plan: scopedPlan.id,
                                  name: scopedPlan.name,
                                });
                            })
                        }
                      >
                        <X />
                      </Button>
                    ),
                  })}
              />
            </>
          )}
          {!trash && (offset > 0 || total > PAGE_SIZE) && (
            <div className="pagination">
              <Button
                variant="ghost"
                size="sm"
                ref={previousButton}
                disabled={offset === 0}
                onClick={() => {
                  paged.current = "previous";
                  setOffset(Math.max(0, offset - PAGE_SIZE));
                }}
              >
                Previous
              </Button>
              <span>
                {" "}
                Showing {offset + 1}–{offset + tickets.length} of {total}{" "}
              </span>
              <Button
                variant="ghost"
                size="sm"
                ref={nextButton}
                disabled={offset + tickets.length >= total}
                onClick={() => {
                  paged.current = "next";
                  setOffset(offset + PAGE_SIZE);
                }}
              >
                Next
              </Button>
            </div>
          )}
        </>
      }
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
          plans={plans}
        />
      )}
    </section>
  );
}
