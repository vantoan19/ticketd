import { useEffect, useRef, useState, type RefObject } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { PlanHeader } from "@/features/plans/PlanHeader";
import { usePlanView } from "@/features/plans/usePlanView";
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
  planMode,
  setPlanMode,
  onOpen,
  onCreate,
}: {
  workspace: TicketWorkspace;
  bulk: BulkEdit;
  listRef: RefObject<HTMLElement | null>;
  planMode: "list" | "dependencies";
  setPlanMode: (mode: "list" | "dependencies") => void;
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
    revision,
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
  const planState = usePlanView(planScope, revision, refresh);
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
  return (
    <section
      className="ticket-list"
      ref={listRef}
      tabIndex={-1}
      aria-labelledby="tickets-heading"
    >
      {scopedPlan ? (
        <PlanHeader
          key={scopedPlan.id}
          plan={scopedPlan}
          plans={plans}
          state={planState}
        >
          <TicketFilters part="controls" {...filterProps} />
        </PlanHeader>
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
            disabled={sourceRefresh.running}
            onClick={() =>
              void (configuredSources.length > 0 ? refreshSources() : refresh())
            }
          >
            <RefreshCw />
          </IconButton>
          {!trash && <TicketFilters part="controls" {...filterProps} />}
          {configuredSources.length > 0 && (
            <SourceRefresh
              providers={configuredSources}
              state={sourceRefresh}
              tickets={tickets}
            />
          )}
        </div>
      )}
      {scopedPlan && (
        <div className="plan-view-switch">
          <SegmentedControl
            aria-label="Plan view"
            value={planMode}
            onValueChange={setPlanMode}
            options={[
              { value: "list", label: "List" },
              { value: "dependencies", label: "Dependencies" },
            ]}
          />
        </div>
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
                  <p>
                    {query ? (
                      <>
                        Nothing matches <q>{query}</q> in {scopeName}
                        {tags || status || availability || family || plan
                          ? " with the current filters"
                          : ""}
                        .
                      </>
                    ) : (
                      "Nothing matches the current filters."
                    )}
                  </p>
                  <div className="plan-empty-actions">
                    {query && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setQuery("");
                          setOffset(0);
                        }}
                      >
                        Clear search
                      </Button>
                    )}
                    {(tags || status || availability || family || plan) && (
                      <Button variant="outline" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    )}
                  </div>
                </>
              ) : planScope ? (
                <>
                  <strong>No tickets in this Plan</strong>
                  <p>Start with a new ticket, or bring in existing ones.</p>
                  <div className="plan-empty-actions">
                    <Button onClick={(event) => onCreate(event.currentTarget)}>
                      <Plus data-icon="inline-start" /> Create ticket
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => planState.setAdding(true)}
                    >
                      Add existing tickets
                    </Button>
                  </div>
                </>
              ) : navigation.project !== "all" ||
                navigation.plan ||
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
                  <p>
                    Create your first ticket to start keeping track of work.
                  </p>
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
