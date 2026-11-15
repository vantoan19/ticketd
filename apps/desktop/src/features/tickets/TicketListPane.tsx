import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Layers,
  Plus,
  RefreshCw,
  SearchX,
  Ticket as TicketIcon,
  Trash2,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureDetails, FailureState } from "@/components/ui/failure-alert";
import { Button } from "@/components/ui/button";
import { Pager } from "@/components/ui/pager";
import { Count } from "@/components/ui/count";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeader } from "@/components/ui/list-header";
import { StatusLineRegion } from "@/components/ui/status-line";
import { useStatusLine } from "@/components/ui/use-status-line";
import { emptyCopy } from "@/lib/empty-copy";
import { noun, ofTotal } from "@/lib/format";
import type { PlanViewState } from "@/features/plans/usePlanView";
import { plansClient } from "@/lib/api/plans";
import { planSummary } from "@/features/plans/plan-summary";
import { BulkControls } from "@/features/tickets/BulkControls";
import { MarkDuplicateDialog } from "@/features/tickets/MarkDuplicateDialog";
import { TicketFilters } from "@/features/tickets/TicketFilters";
import { useFiltersMenu } from "@/features/tickets/filters-menu";
import { SourceFilter, SourceRefresh } from "@/features/tickets/SourceFilter";
import { TicketList } from "@/features/tickets/TicketList";
import { TicketBoard } from "./TicketBoard";
import { DisplayMenu } from "@/features/tickets/DisplayMenu";
import { usePreferences } from "@/lib/preferences";
import { TicketRowsSkeleton } from "@/features/tickets/TicketRowsSkeleton";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { Ticket } from "@/lib/api/client";
import {
  PAGE_SIZE,
  type TicketWorkspace,
} from "@/features/tickets/useTicketWorkspace";

type Props = Parameters<typeof TicketListBody>[0];

/**
 * The list header, filters, bulk editing, result states, and pagination. The
 * pane has its own status line for outcomes such as "Removed T-1 from Q3 ·
 * Undo".
 */
export function TicketListPane(props: Props) {
  return (
    <StatusLineRegion host={props.listRef}>
      <TicketListBody {...props} />
    </StatusLineRegion>
  );
}

function TicketListBody({
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
  const { ticketRows } = usePreferences();
  const {
    projects,
    plans,
    filter,
    query,
    setQuery,
    pages,
    resetPaging,
    showMore,
    matchingReferences,
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
    listFailure,
    refreshFailed,
  } = workspace;
  // A Plan scope shows the Plan's own header instead of a plain title.
  const [markingDuplicate, setMarkingDuplicate] = useState(false);
  const statusLine = useStatusLine();
  // The header's Filters menu and the chip row under it share one menu.
  const filtersMenu = useFiltersMenu();
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
  const filterCount =
    [plan, status, availability, family].filter(Boolean).length +
    tags.split(",").filter((tag) => tag.trim()).length;
  // Chrome rule (P9): Search, Filters and Display act on nothing in an empty
  // workspace or an empty Trash. A narrower view that is empty keeps them,
  // since its tickets may only be elsewhere in the workspace.
  const bare =
    !loading &&
    !queryError &&
    !refreshFailed &&
    total === 0 &&
    tickets.length === 0 &&
    !filtered &&
    (trash ||
      (navigation.kind === "all" &&
        navigation.project === "all" &&
        !navigation.plan));
  const visibleTickets = tickets.filter(
    (item) =>
      filter === "all" ||
      (filter === "unlinked"
        ? item.project_id === null
        : item.project_id === filter),
  );
  const visibleTicketsRef = useRef(visibleTickets);
  useEffect(() => {
    visibleTicketsRef.current = visibleTickets;
  });
  // A selection belongs to the view it was made in. Another scope, search,
  // filter or layout drops it, so the bar never acts on tickets that are no
  // longer listed; the board has no bar, so a selection never waits hidden
  // there (list B-08). Showing more keeps it.
  const viewKey = JSON.stringify([
    workspace.layout,
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
  // "Show 50 more" (P17): the next rows arrive where the button was. For a
  // moment a click there is ignored, so a double click never opens a ticket
  // that slid under the pointer, and keyboard focus moves to the first new
  // row (list BD-09).
  const arriving = useRef<{ from: number; focused: boolean } | null>(null);
  const guardUntil = useRef(0);
  const shownCount = visibleTickets.length;
  useEffect(() => {
    const pending = arriving.current;
    if (!pending || shownCount <= pending.from) return;
    arriving.current = null;
    guardUntil.current = Date.now() + 400;
    const first = visibleTicketsRef.current[pending.from];
    if (pending.focused && first)
      listRef.current
        ?.querySelector<HTMLElement>(
          `[data-ticket-reference="${first.reference}"]`,
        )
        ?.focus();
  }, [shownCount, listRef]);
  const { clearSelection } = bulk;
  useEffect(() => {
    if (previousView.current === viewKey) return;
    previousView.current = viewKey;
    clearSelection();
  }, [viewKey, clearSelection]);
  // Failures and confirmations stay mounted so the bar can post them to the
  // status line; the bar itself shows only while tickets are selected.
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
    resetPaging,
    navigation,
    clearFilters,
    scopeName,
    total,
    scopeTotal,
    counts,
    menu: filtersMenu,
  };
  return (
    <section
      className="ticket-list"
      ref={listRef}
      tabIndex={-1}
      aria-labelledby="tickets-heading"
    >
      {scopedPlan ? (
        <div className="plan-list-toolbar">
          {planState.view && (
            <span className="plan-list-summary">
              {planSummary(planState.view.members, projects)}
            </span>
          )}
          <span className="plan-list-spacer" />
          {!bare && <TicketFilters part="controls" {...filterProps} />}
          {!bare && <DisplayMenu onError={workspace.setError} rowsOnly />}
        </div>
      ) : (
        <PaneHeader
          title={scopeName}
          titleId="tickets-heading"
          caption={singleStatusNote}
          count={
            <Count>
              {filtered && scopeTotal != null
                ? ofTotal(total, scopeTotal)
                : total}
              {!(filtered && scopeTotal != null) && (
                <span className="sr-only"> {noun(total, "ticket")}</span>
              )}
            </Count>
          }
          actions={
            <>
              {configuredSources.length > 0 && (
                <SourceRefresh
                  providers={configuredSources}
                  state={sourceRefresh}
                  tickets={tickets}
                />
              )}
              {/* Refresh always keeps its slot, so the header never shifts (P10). */}
              <IconButton
                label="Refresh"
                disabled={sourceRefresh.running}
                onClick={() =>
                  void (configuredSources.length > 0
                    ? refreshSources()
                    : refresh({ reportFailure: true }))
                }
              >
                <RefreshCw />
              </IconButton>
              {!trash && !bare && (
                <TicketFilters part="controls" {...filterProps} />
              )}
              {!bare && (
                <DisplayMenu
                  onError={workspace.setError}
                  rowsOnly={trash || Boolean(navigation.plan)}
                />
              )}
            </>
          }
        />
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
            <div role="status" className="refresh-failed">
              Can’t refresh. Showing the last{" "}
              {workspace.layout === "board" ? "board" : "list"}.{" "}
              <Button
                variant="link"
                size="sm"
                onClick={() => void refresh({ reportFailure: true })}
              >
                Retry
              </Button>
              {workspace.listFailure && (
                <FailureDetails small details={workspace.listFailure.details} />
              )}
            </div>
          )}
          {workspace.layout === "board" ? (
            <TicketBoard
              workspace={workspace}
              onOpen={onOpen}
              {...(!addDisabled &&
                !trash && {
                  onAdd: (status: string, trigger: HTMLButtonElement) =>
                    onCreate(trigger, status),
                })}
            />
          ) : (
            <div className="ticket-scroll">
              {queryError ? (
                <FailureState
                  failure={
                    listFailure ?? {
                      code: "failed",
                      title: "Couldn't load tickets",
                      sentence:
                        "ticketd couldn't read the list. Nothing changed.",
                      action: "retry",
                      details: "",
                    }
                  }
                  onRetry={() => void refresh({ reportFailure: true })}
                />
              ) : loading && tickets.length === 0 ? (
                <TicketRowsSkeleton />
              ) : tickets.length === 0 ? (
                trash ? (
                  <EmptyState
                    icon={<Trash2 />}
                    {...copyProps(emptyCopy("tickets-trash"))}
                  />
                ) : filtered ? (
                  <EmptyState
                    icon={<SearchX />}
                    {...copyProps(
                      emptyCopy(
                        query
                          ? filterCount
                            ? "tickets-search-filtered"
                            : "tickets-search"
                          : "tickets-filters",
                        { query, name: scopeName, filters: filterCount },
                      ),
                    )}
                    action={
                      query || filterCount > 0 ? (
                        <>
                          {query && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setQuery("");
                                resetPaging();
                              }}
                            >
                              Clear search
                            </Button>
                          )}
                          {filterCount > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={clearFilters}
                            >
                              Clear filters
                            </Button>
                          )}
                        </>
                      ) : undefined
                    }
                  />
                ) : planScope ? (
                  <EmptyState
                    icon={<Layers />}
                    {...copyProps(
                      emptyCopy(addDisabled ? "plan-archived" : "plan-empty", {
                        name: scopedPlan?.name ?? scopeName,
                      }),
                    )}
                    action={
                      addDisabled ? undefined : (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => planState.setAdding(true)}
                          >
                            Add to Plan…
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(event) => onCreate(event.currentTarget)}
                          >
                            New ticket
                          </Button>
                        </>
                      )
                    }
                  />
                ) : navigation.kind === "ready" ? (
                  <EmptyState
                    icon={<TicketIcon />}
                    {...copyProps(emptyCopy("tickets-ready"))}
                  />
                ) : navigation.kind === "progress" ? (
                  <EmptyState
                    icon={<TicketIcon />}
                    {...copyProps(emptyCopy("tickets-progress"))}
                  />
                ) : navigation.project === "unlinked" ? (
                  <EmptyState
                    icon={<TicketIcon />}
                    {...copyProps(emptyCopy("tickets-no-project"))}
                  />
                ) : navigation.project !== "all" ? (
                  <EmptyState
                    icon={<TicketIcon />}
                    {...copyProps(
                      emptyCopy("tickets-project", { name: scopeName }),
                    )}
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(event) => onCreate(event.currentTarget)}
                      >
                        New ticket
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<TicketIcon />}
                    {...copyProps(emptyCopy("tickets-first-run"))}
                    action={
                      <Button
                        size="sm"
                        onClick={(event) => onCreate(event.currentTarget)}
                      >
                        <Plus data-icon="inline-start" /> New ticket
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
                    readyView={navigation.kind === "ready"}
                    simple={ticketRows === "simple"}
                    // A status filter keeps its group header (board C); only the
                    // dedicated Ready and In progress views drop it.
                    singleStatus={
                      navigation.kind === "ready" ||
                      navigation.kind === "progress"
                    }
                    {...(grouped &&
                      counts && {
                        grouping: {
                          counts,
                          ...(!addDisabled && {
                            onAdd: (
                              status: string,
                              trigger: HTMLButtonElement,
                            ) => {
                              if (status === "Duplicate")
                                setMarkingDuplicate(true);
                              else onCreate(trigger, status);
                            },
                          }),
                        },
                      })}
                    selectable={!trash}
                    selectionDisabled={bulk.pending}
                    bulkSelection={bulk.selection}
                    onToggle={bulk.toggle}
                    onSelectMany={bulk.selectAll}
                    onOpen={(reference) => {
                      if (Date.now() < guardUntil.current) return;
                      onOpen(reference);
                    }}
                    {...(scopedPlan &&
                      planWritable && {
                        rowAction: (ticket: Ticket) => (
                          <IconButton
                            disabled={planState.pending}
                            label={`Remove ${ticket.reference} from ${scopedPlan.name}`}
                            onClick={() =>
                              void planState
                                .run(() =>
                                  plansClient.setMember(ticket.reference, null),
                                )
                                .then((done) => {
                                  if (!done) return;
                                  const { reference } = ticket;
                                  const { id, name } = scopedPlan;
                                  statusLine.show({
                                    message: `Removed ${reference} from ${name}`,
                                    undo: async () => {
                                      const back = await planState.run(() =>
                                        plansClient.setMember(reference, id),
                                      );
                                      if (!back)
                                        throw new Error(
                                          `${reference} is still outside ${name}`,
                                        );
                                    },
                                  });
                                })
                            }
                          >
                            <X />
                          </IconButton>
                        ),
                      })}
                  />
                </>
              )}
              {!trash &&
                !queryError &&
                tickets.length > 0 &&
                tickets.length < total && (
                  <Pager
                    more={Math.min(PAGE_SIZE, total - tickets.length)}
                    noun="tickets"
                    loading={loading && pages * PAGE_SIZE > tickets.length}
                    onMore={() => {
                      arriving.current = {
                        from: visibleTickets.length,
                        focused:
                          document.activeElement?.closest(
                            '[data-slot="pager"]',
                          ) != null,
                      };
                      showMore();
                    }}
                  />
                )}
            </div>
          )}
        </>
      }
      <MarkDuplicateDialog
        open={markingDuplicate}
        onOpenChange={setMarkingDuplicate}
        refresh={refresh}
      />
      {showBulk && workspace.layout === "list" && (
        <BulkControls
          bulk={bulk}
          visible={visibleTickets}
          total={total}
          matchingReferences={matchingReferences}
          projects={projects}
          plans={plans}
        />
      )}
    </section>
  );
}

/** An empty state's title and sentence from the copy registry. */
function copyProps(copy: { title: string; sentence: string }) {
  return { title: copy.title, description: copy.sentence };
}
