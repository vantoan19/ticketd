import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { m } from "motion/react";
import { Presence } from "@/components/ui/motion";
import { blur, exitTransition } from "@/lib/motion-tokens";
import {
  ArchiveRestore,
  Layers,
  SearchX,
  Ticket as TicketIcon,
  Trash2,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import { FailureDetails, FailureState } from "@/components/ui/failure-alert";
import { Button } from "@/components/ui/button";
import { Pager } from "@/components/ui/pager";
import { Count } from "@/components/ui/count";
import { IconButton } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import { useProjectLifecycle } from "@/features/projects/useProjectLifecycle";
import { PaneHeader, PaneHeaderButton } from "@/components/ui/list-header";
import { StatusLineRegion } from "@/components/ui/status-line";
import { useStatusLineInset } from "@/components/ui/use-status-line";
import { emptyCopy } from "@/lib/empty-copy";
import { noun, ofTotal } from "@/lib/format";
import {
  usePlanAction,
  type PlanViewState,
} from "@/features/plans/usePlanView";
import { plansClient } from "@/lib/api/plans";
import { allowRemoval } from "@/lib/removal-guard";
import { BulkControls } from "@/features/tickets/BulkControls";
import { MarkDuplicateDialog } from "@/features/tickets/MarkDuplicateDialog";
import { TicketFilters } from "@/features/tickets/TicketFilters";
import { useListCascade } from "@/features/tickets/use-list-cascade";
import {
  useFiltersMenu,
  type FiltersMenuState,
} from "@/features/tickets/filters-menu";
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
  filtersMenu: sharedFiltersMenu,
  projectNotice,
}: {
  workspace: TicketWorkspace;
  bulk: BulkEdit;
  listRef: RefObject<HTMLElement | null>;
  planState: PlanViewState;
  onOpen: (reference: string) => void;
  onCreate: (trigger: HTMLButtonElement, status?: string) => void;
  /** The Plan header's Filters menu, which the chip row shares. */
  filtersMenu?: FiltersMenuState;
  projectNotice?: ReactNode;
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
    status,
    tags,
    availability,
    family,
    source,
    setSource,
    sourceCounts,
    configuredSources,
    sourceRefresh,
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
  // Complete well counts are an independent, authoritative total while the
  // shared list read is unavailable; a failed well retains its own Retry.
  const boardTotal =
    workspace.layout === "board" &&
    workspace.board.columns.every((column) => column.total !== null)
      ? workspace.board.columns.reduce(
          (sum, column) => sum + (column.total ?? 0),
          0,
        )
      : null;
  const headerTotal = boardTotal ?? total;
  // Back from the Board, or in place of the placeholders, the rows fade up top
  // first, once.
  const waiting = loading && tickets.length === 0;
  const { cascade, done: cascaded } = useListCascade(workspace.layout, waiting);
  // A Plan scope shows the Plan's own header instead of a plain title.
  const [markingDuplicate, setMarkingDuplicate] = useState(false);
  const planAction = usePlanAction(planState);
  const lastRemoval = useRef(0);
  // The header's Filters menu and the chip row under it share one menu; in a
  // Plan scope the menu sits in the Plan header, which passes its state in.
  const ownFiltersMenu = useFiltersMenu();
  const filtersMenu = sharedFiltersMenu ?? ownFiltersMenu;
  const planScope = !trash && navigation.plan ? navigation.plan : "";
  const scopedPlan = plans.find((item) => item.id === planScope);
  // An archived Plan is read-only: no new tickets into it, no removing from it.
  const planWritable = scopedPlan !== undefined && !scopedPlan.archived;
  const scopedProject =
    !trash && !scopedPlan
      ? projects.find((project) => project.id === navigation.project)
      : undefined;
  const archivedProject = scopedProject?.archived ? scopedProject : undefined;
  const addDisabled = scopedPlan?.archived === true || Boolean(archivedProject);
  const projectLifecycle = useProjectLifecycle(refresh);
  const focusFilter = useRef<string | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || list.closest("[hidden]")) return;
    if (
      archivedProject &&
      lastFocused.current?.matches("[data-project-add]") &&
      !lastFocused.current.isConnected &&
      document.activeElement === document.body
    ) {
      list.focus();
    }
    if (
      focusFilter.current &&
      scopedProject?.id === focusFilter.current &&
      !archivedProject
    ) {
      focusFilter.current = null;
      (
        list.querySelector<HTMLButtonElement>(
          "[data-ticket-filters-trigger]",
        ) ?? list
      ).focus();
    }
  }, [archivedProject, listRef, scopedProject]);
  const filtered =
    navigation.plan !== plan ||
    status !== (navigation.kind === "progress" ? "In progress" : "") ||
    availability !== (navigation.kind === "ready" ? "Ready" : "") ||
    Boolean(query || tags || family) ||
    source !== "all";
  const filterCount = [
    navigation.plan !== plan ? plan : "",
    navigation.kind !== "progress" ? status : "",
    navigation.kind !== "ready" ? availability : "",
    family,
    tags,
  ].filter(Boolean).length;
  // Empty unfiltered scopes share one rule; filtered empty scopes keep a way back.
  const bare =
    !loading &&
    !queryError &&
    !refreshFailed &&
    total === 0 &&
    tickets.length === 0 &&
    !filtered;
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
  const filterProps = { ...filterPropsOf(workspace), menu: filtersMenu };
  // What an empty list or board says (P9): one state for the whole view.
  const emptyView = trash ? (
    <EmptyState icon={<Trash2 />} {...copyProps(emptyCopy("tickets-trash"))} />
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
              <Button variant="outline" size="sm" onClick={clearFilters}>
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
        emptyCopy(
          archivedProject ? "tickets-project-archived" : "tickets-project",
          { name: scopeName },
        ),
      )}
      action={
        !archivedProject && (
          <Button
            variant="outline"
            size="sm"
            data-project-add=""
            onClick={(event) => onCreate(event.currentTarget)}
          >
            New ticket
          </Button>
        )
      }
    />
  ) : (
    <EmptyState
      icon={<TicketIcon />}
      {...copyProps(emptyCopy("tickets-first-run"))}
      action={
        <Button
          size="sm"
          aria-keyshortcuts={ariaKeyShortcuts("new-ticket")}
          onClick={(event) => onCreate(event.currentTarget)}
        >
          New ticket
          <Kbd tone="inverted" aria-hidden="true">
            {shortcutLabel("new-ticket")}
          </Kbd>
        </Button>
      }
    />
  );
  return (
    <section
      className="ticket-list"
      ref={listRef}
      tabIndex={-1}
      aria-labelledby="tickets-heading"
      onFocusCapture={(event) => {
        lastFocused.current = event.target;
      }}
    >
      {/* A Plan's own header, above both panes, holds its controls. */}
      {!scopedPlan && (
        <PaneHeader
          title={scopeName}
          titleId="tickets-heading"
          count={
            // First run (S20): the title alone over an empty workspace.
            (workspace.listKnown || boardTotal !== null) &&
            !bare && (
              // The noun sits outside Count so the number alone crossfades.
              <>
                <Count>
                  {filtered && scopeTotal != null
                    ? ofTotal(headerTotal, scopeTotal)
                    : headerTotal}
                </Count>
                {!(filtered && scopeTotal != null) && (
                  <span className="sr-only">
                    {" "}
                    {noun(headerTotal, "ticket")}
                  </span>
                )}
              </>
            )
          }
          actions={
            <>
              {archivedProject && (
                <PaneHeaderButton
                  variant="outline"
                  icon={<ArchiveRestore />}
                  label="Reactivate"
                  disabled={projectLifecycle.pending.has(archivedProject.id)}
                  onClick={() =>
                    void projectLifecycle.change(archivedProject, false, {
                      beforeRefresh: () => {
                        focusFilter.current = archivedProject.id;
                      },
                    })
                  }
                />
              )}
              {configuredSources.length > 0 && (
                <SourceRefresh
                  providers={configuredSources}
                  state={sourceRefresh}
                  tickets={tickets}
                />
              )}
              {!trash && (!bare || scopedProject) && (
                <TicketFilters part="controls" {...filterProps} />
              )}
              {(!bare || archivedProject) && (
                <DisplayMenu
                  onError={workspace.setError}
                  rowsOnly={trash || Boolean(navigation.plan)}
                />
              )}
            </>
          }
        >
          {archivedProject && <Badge size="sm">Archived</Badge>}
        </PaneHeader>
      )}
      {!trash && !scopedPlan && projectNotice}
      {!trash && <TicketFilters part="chips" {...filterProps} />}
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
          {/* Choosing Board: the rows fade out, then the columns fade up. The
              header and the Display menu stay put. */}
          <Presence mode="wait" initial={false}>
            {workspace.layout === "board" ? (
              <TicketBoard
                key="board"
                workspace={workspace}
                empty={
                  !loading && !queryError && tickets.length === 0
                    ? emptyView
                    : null
                }
                onOpen={onOpen}
                {...(!addDisabled &&
                  !trash && {
                    onAdd: (status: string, trigger: HTMLButtonElement) =>
                      onCreate(trigger, status),
                  })}
              />
            ) : (
              <m.div
                key="list"
                className="ticket-scroll"
                // The rows glide from where they were on screen, not from
                // where they sat before the list scrolled.
                layoutScroll
                exit={{
                  opacity: 0,
                  filter: `blur(${blur("out")}px)`,
                  transition: exitTransition(),
                }}
              >
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
                ) : waiting ? (
                  <TicketRowsSkeleton detailed={ticketRows === "detailed"} />
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
                      scopeKey={JSON.stringify([
                        filter,
                        plan,
                        status,
                        tags,
                        availability,
                        family,
                        source,
                        query,
                        trash,
                      ])}
                      cascade={cascade}
                      onCascaded={cascaded}
                      tickets={visibleTickets}
                      empty={emptyView}
                      scope={{
                        showPlan: !navigation.plan,
                        showProject: navigation.project === "all",
                        plans,
                        projects,
                      }}
                      selected={selected}
                      readyView={navigation.kind === "ready"}
                      trashView={trash}
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
                              tooltipSide="top"
                              onClick={() => {
                                // A second click lands on the row that moved up:
                                // ignore clicks for 400ms after a removal (P7).
                                if (!allowRemoval(lastRemoval)) return;
                                const { reference } = ticket;
                                const { id, name } = scopedPlan;
                                void planAction(
                                  () => plansClient.setMember(reference, null),
                                  `remove ${reference} from ${name}`,
                                  {
                                    message: `Removed ${reference} from ${name}`,
                                    undo: () =>
                                      planState.apply(() =>
                                        plansClient.setMember(reference, id),
                                      ),
                                  },
                                );
                              }}
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
              </m.div>
            )}
          </Presence>
        </>
      }
      <MarkDuplicateDialog
        open={markingDuplicate}
        onOpenChange={setMarkingDuplicate}
      />
      <ListOverlays>
        {/* Always mounted in the list so the bar can sink away when cleared. */}
        {!trash && workspace.layout === "list" && (
          <BulkControls
            bulk={bulk}
            visible={visibleTickets}
            total={total}
            matchingReferences={matchingReferences}
            projects={projects}
            plans={plans}
          />
        )}
      </ListOverlays>
    </section>
  );
}

/** Bulk actions float at the bottom; outcomes clear their reserved stack. */
function ListOverlays({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useStatusLineInset(height > 0 ? height + 8 : 0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect().height;
      setHeight(next);
      element
        .closest<HTMLElement>(".ticket-list")
        ?.style.setProperty("--list-overlays-height", `${next}px`);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
    // Measured once on mount; the observer follows every later size change.
  }, []);
  return (
    <div className="ticket-list-overlays" ref={ref}>
      {children}
    </div>
  );
}

/** An empty state's title and sentence from the copy registry. */
function copyProps(copy: { title: string; sentence: string }) {
  return { title: copy.title, description: copy.sentence };
}

/** The props the Filters controls and chips share, from the workspace. */
function filterPropsOf(w: TicketWorkspace) {
  return {
    query: w.query,
    setQuery: w.setQuery,
    plan: w.plan,
    setPlan: w.setPlan,
    status: w.status,
    setStatus: w.setStatus,
    tags: w.tags,
    setTags: w.setTags,
    availability: w.availability,
    setAvailability: w.setAvailability,
    family: w.family,
    setFamily: w.setFamily,
    plans: w.plans,
    resetPaging: w.resetPaging,
    navigation: w.navigation,
    clearFilters: w.clearFilters,
    scopeName: w.scopeName,
    total: w.total,
    scopeTotal: w.scopeTotal,
    counts: w.counts,
  };
}

/**
 * Filters and Display for a Plan's list and board, reached through the
 * Plan header's More menu instead of a second list header.
 */
export function PlanListControls({
  workspace,
  filtersMenu,
}: {
  workspace: TicketWorkspace;
  /** Shared with the list's chip row, so a chip reopens this menu. */
  filtersMenu: FiltersMenuState;
}) {
  return (
    <>
      <TicketFilters
        part="controls"
        {...filterPropsOf(workspace)}
        menu={filtersMenu}
      />
      <DisplayMenu onError={workspace.setError} rowsOnly />
    </>
  );
}
