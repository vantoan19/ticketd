import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTicketBoard } from "./useTicketBoard";
import { useBoardStatus } from "./useBoardStatus";
import {
  client,
  type FindFilter,
  type Project,
  type SourceCounts,
  type StatusCounts,
  type Ticket,
} from "@/lib/api/client";
import {
  sourcesClient,
  type RefreshReport,
  type SourceEntry,
  type SourceHealth,
} from "@/lib/api/sources";
import { loadPreferences, usePreferences } from "@/lib/preferences";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  useOnWorkspaceChange,
  useWorkspaceChange,
} from "@/lib/workspace-change";
import { useWrote } from "@/lib/workspace-reads";
import type { MentionTarget } from "./Backlinks";
export const PAGE_SIZE = 50;

/**
 * Reads the first `pages` pages of a result, PAGE_SIZE at a time (the core
 * caps one read at 100), stopping at a short page.
 */
async function readPages(filter: FindFilter, pages: number) {
  const tickets: Ticket[] = [];
  for (let page = 0; page < pages; page++) {
    const chunk = await client.findTickets({
      ...filter,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    tickets.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
  }
  // A ticket that moved between reads is listed once.
  return [...new Map(tickets.map((ticket) => [ticket.id, ticket])).values()];
}
type RefreshOptions = { reportFailure?: boolean };
type View = "tickets" | "projects" | "plans" | "settings" | "inbox";
/**
 * A mention being followed. It is not `ready` until the selected ticket's record
 * is current (`useTicket().current`), so it is judged against the stored text
 * rather than a copy a change has made stale.
 */
export type FollowedMention = MentionTarget & { key: number; ready: boolean };
export type TicketWorkspace = ReturnType<typeof useTicketWorkspace>;
function markReady(
  mention: FollowedMention | null,
  reference: string | null,
): FollowedMention | null {
  return mention && !mention.ready && mention.reference === reference
    ? { ...mention, ready: true }
    : mention;
}
export function useTicketWorkspace(
  setView: (view: View) => void,
  setCreating: (value: boolean) => void,
) {
  const { ticketLayout } = usePreferences();
  const [projects, setProjects] = useState<Project[]>([]);
  const [plans, setPlans] = useState<
    { id: string; name: string; archived: boolean; purpose: string }[]
  >([]);
  const [filter, setFilter] = useState("all");
  const [navigation, setNavigation] = useState<{
    kind: "all" | "ready" | "progress" | "trash";
    project: string;
    plan: string;
  }>({ kind: "all", project: "all", plan: "" });
  const [queryError, setQueryError] = useState(false);
  // A failed refresh after a list was shown keeps that list rather than blanking it.
  const [refreshFailed, setRefreshFailed] = useState(false);
  const listLoaded = useRef(false);
  const [listKnown, setListKnown] = useState(false);
  const [plansKnown, setPlansKnown] = useState(false);
  const [plansFailure, setPlansFailure] = useState<FailureDescription | null>(
    null,
  );
  const plansGeneration = useRef(0);
  const refreshPlans = useCallback(async () => {
    const request = ++plansGeneration.current;
    try {
      const items = await client.listPlans();
      if (request !== plansGeneration.current) return;
      setPlans(items);
      setPlansKnown(true);
      setPlansFailure(null);
    } catch (reason) {
      if (request === plansGeneration.current)
        setPlansFailure(describeFailure(reason, "load Plans"));
    }
  }, []);
  const lastSnapshot = useRef("");
  const [query, setQuery] = useState("");
  // How many pages of PAGE_SIZE the list shows: "Show 50 more" adds one
  // (P17); every change of scope, search or filter starts again at one.
  const [pages, setPages] = useState(1);
  const resetPaging = useCallback(() => setPages(1), []);
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("");
  const [tags, setTags] = useState("");
  const [availability, setAvailability] = useState("");
  const [family, setFamily] = useState("");
  // "all", "local", or a provider id such as "github".
  const [source, setSourceFilter] = useState("all");
  // The connectors and what is saved for each. The source filter appears once one is saved.
  const [sourceEntries, setSourceEntries] = useState<SourceEntry[]>([]);
  const configuredSources = sourceEntries
    .filter((entry) => entry.saved)
    .map((entry) => entry.connector.provider);
  const [sourceCounts, setSourceCounts] = useState<SourceCounts | null>(null);
  // What the core persisted about each source's freshness, and whether a refresh
  // (startup, periodic or explicit) is running. Kept when a read fails, so a
  // transient error never blanks the footer or claims a refresh succeeded.
  const [sourceHealth, setSourceHealth] = useState<SourceHealth>({
    refreshing: false,
    sources: [],
  });
  const [sourceRefresh, setSourceRefresh] = useState<{
    running: boolean;
    report: RefreshReport | null;
    error: string;
    errorAt: string | null;
  }>({ running: false, report: null, error: "", errorAt: null });
  const [trash, setTrash] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The counts describe the whole filtered result; they are null in Trash,
  // which lists tickets flat.
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  // How many tickets the scope holds without search or filters; null while
  // nothing is narrowing it.
  const [scopeTotal, setScopeTotal] = useState<number | null>(null);
  // Next past the last shown ticket loads more and then opens the one after.
  const [pendingNext, setPendingNext] = useState<number | null>(null);
  const [selected, selectTicket] = useState<string | null>(null);
  const [mention, setMention] = useState<FollowedMention | null>(null);
  // The Tickets opened in this session, in the order they were first selected.
  // Each keeps its page mounted (hidden unless selected) in its Open Ticket.
  const [opened, setOpened] = useState<string[]>([]);
  // Every selection ends the previous mention; following a backlink starts one.
  const setSelected = useCallback(
    (reference: string | null, target?: MentionTarget) => {
      selectTicket(reference);
      if (reference)
        setOpened((items) =>
          items.includes(reference) ? items : [...items, reference],
        );
      setMention(target ? { ...target, key: Date.now(), ready: false } : null);
    },
    [],
  );
  const clearMention = useCallback(() => setMention(null), []);
  const markMentionReady = useCallback(
    (reference: string) =>
      setMention((current) => markReady(current, reference)),
    [],
  );
  // The latest copy of each Ticket this window wrote, so a list row that was
  // held in place can tell it has moved once the list no longer holds it.
  const [written, setWritten] = useState<Record<string, Ticket>>({});
  const clearOpened = useCallback(() => {
    setOpened([]);
    setWritten({});
  }, []);
  const wrote = useWrote();
  // A local preference (sidebar, display) that could not be saved. It stays
  // until dismissed: a later list load has nothing to do with it.
  const [error, setError] = useState("");
  // Why the list could not load, for the list's own failure state. Nothing is
  // reported window-wide: the pane that failed says so.
  const [listFailure, setListFailure] = useState<FailureDescription | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [listRevision, setRevision] = useState(0);
  // The list only changes when a listed ticket does, but a Document, Activity or
  // another ticket can change what the open ticket's page shows. Pages key their
  // reads on this revision, so it also moves with every workspace change.
  const workspaceChange = useWorkspaceChange();
  const revision = listRevision + workspaceChange;
  // Advances on every successful poll, changed data or not, for views that poll their own sources.
  const [pollTick, setPollTick] = useState(0);
  const generation = useRef(0);
  // Only the scope's own fields matter to a fetch; depending on the object would
  // refetch whenever the same scope is chosen again.
  const scopeKind = navigation.kind;
  const scopePlan = navigation.plan;
  const layout = !trash ? ticketLayout : "list";
  const filterArgs = useMemo<FindFilter>(
    () => ({
      query,
      project: filter === "all" || filter === "unlinked" ? null : filter,
      unlinked: filter === "unlinked",
      plan: plan || null,
      status: status || null,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      availability: availability || null,
      family: family || null,
      source:
        source === "all"
          ? null
          : source === "local"
            ? "Local"
            : { Provider: source },
      order: query ? "Newest" : "Workflow",
      limit: PAGE_SIZE,
      offset: 0,
    }),
    [query, filter, plan, status, tags, availability, family, source],
  );
  const board = useTicketBoard(filterArgs, layout === "board", workspaceChange);
  const refreshBoard = board.refresh;
  const refresh = useCallback(
    async (options?: RefreshOptions) => {
      const request = ++generation.current;
      void refreshPlans();
      let timeout = 0;
      try {
        // A search lists newest first, like Trash; every other list is grouped by
        // status, so it pages through workflow order.
        // What the scope alone would list, so a filtered list can say "N of M".
        const unfiltered: FindFilter = {
          ...filterArgs,
          query: "",
          plan: scopePlan || null,
          status: scopeKind === "progress" ? "In progress" : null,
          tags: [],
          availability: scopeKind === "ready" ? "Ready" : null,
          family: null,
          order: "Workflow",
        };
        const scoped =
          JSON.stringify({ ...unfiltered, order: 0 }) ===
          JSON.stringify({ ...filterArgs, order: 0 });
        const result = await Promise.race([
          Promise.all([
            trash ? client.listTrash() : readPages(filterArgs, pages),
            client.listProjects(),
            trash ? Promise.resolve(null) : client.countTickets(filterArgs),
            // Source counts only decorate the filter, so they never fail the list.
            trash
              ? Promise.resolve(null)
              : client.countBySource(filterArgs).catch(() => null),
            trash || scoped
              ? Promise.resolve(null)
              : client.countTickets(unfiltered).catch(() => null),
            layout === "board" ? refreshBoard() : Promise.resolve(),
          ]),
          new Promise<never>((_, reject) => {
            timeout = window.setTimeout(
              () => reject(new Error("Timed out")),
              5000,
            );
          }),
        ]);
        if (request !== generation.current) return;
        listLoaded.current = true;
        setListKnown(true);
        setPollTick((value) => value + 1);
        setQueryError(false);
        setRefreshFailed(false);
        setListFailure(null);
        // The same data again changes nothing, so views are not told to reload.
        const snapshot = JSON.stringify([trash, pages, result]);
        if (snapshot === lastSnapshot.current) return;
        lastSnapshot.current = snapshot;
        setTickets(result[0]);
        setCounts(result[2]);
        setSourceCounts(result[3]);
        setScopeTotal(result[4]?.total ?? null);
        setProjects(result[1]);
        setRevision((value) => value + 1);
      } catch (reason) {
        if (request !== generation.current) return;
        lastSnapshot.current = "";
        if (listLoaded.current) setRefreshFailed(true);
        else setQueryError(true);
        // Polling keeps the saved list quiet; an explicit retry explains its failure.
        if (!listLoaded.current || options?.reportFailure)
          setListFailure(describeFailure(reason, "load tickets"));
      } finally {
        window.clearTimeout(timeout);
        if (request === generation.current) setLoading(false);
      }
    },
    [
      trash,
      pages,
      scopeKind,
      scopePlan,
      filterArgs,
      layout,
      refreshBoard,
      refreshPlans,
    ],
  );
  useEffect(() => {
    let active = true;
    void sourcesClient.list().then(
      (entries) => {
        if (active) setSourceEntries(entries);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [pollTick]);
  useEffect(() => {
    let active = true;
    void sourcesClient.health().then(
      (health) => {
        if (active) setSourceHealth(health);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [pollTick]);
  useEffect(() => {
    const generationRef = generation;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      generationRef.current++;
    };
  }, [refresh]);
  // Changes from anywhere (the CLI, an agent, another window) refetch the list
  // quietly; an unchanged workspace costs nothing here.
  useOnWorkspaceChange(() => void refresh());
  // Next past the last shown ticket opens the next one once it has loaded.
  if (pendingNext !== null && tickets.length > pendingNext) {
    const target = tickets[pendingNext];
    setPendingNext(null);
    if (target) setSelected(target.reference);
  }
  /**
   * Imports matching issues and refreshes tracked tickets now, optionally only
   * one. Saved content stays visible while it runs and when it fails.
   */
  async function refreshSources(ticket?: string) {
    setSourceRefresh({ running: true, report: null, error: "", errorAt: null });
    try {
      const report = await sourcesClient.refresh(ticket);
      setSourceRefresh({ running: false, report, error: "", errorAt: null });
    } catch (reason) {
      setSourceRefresh({
        running: false,
        report: null,
        error: describeFailure(reason, "refresh").sentence,
        errorAt: new Date().toISOString(),
      });
    }
    await refresh({ reportFailure: true });
  }
  function setSource(next: string) {
    setSourceFilter(next);
    setPages(1);
  }
  async function create(
    title: string,
    body: string,
    status: string,
    project: string | null,
    planId: string | null,
    tags: string[],
    keepOpen = false,
    requestId?: string,
    followCreated?: boolean,
    blockers: string[] = [],
  ) {
    const ticket = await client.createTicket(
      title,
      body,
      status,
      project,
      planId,
      tags,
      followCreated ?? loadPreferences().followCreated,
      requestId,
      blockers,
    );
    // The new Ticket is known at once; reads catch up behind it.
    const reported = wrote({ ticket });
    if (!keepOpen) {
      setCreating(false);
      setSelected(ticket.reference);
    }
    await refresh();
    await reported;
    return ticket.reference;
  }
  // Shows a Ticket a write returned in the list at once (the Ticket list is not
  // on the reads module yet) and drops a list read sent before the write.
  const patchTicket = useCallback((updated: Ticket) => {
    generation.current++;
    setWritten((items) => ({ ...items, [updated.reference]: updated }));
    setTickets((items) =>
      items.map((item) => {
        if (item.id !== updated.id) return item;
        // Detail mutations return a Ticket without the page-only summary.
        // Retain it while it still identifies the same latest Activity.
        return item.progress_summary !== undefined &&
          item.progress_summary?.activity_id ===
            updated.latest_update?.activity_id
          ? { ...updated, progress_summary: item.progress_summary }
          : updated;
      }),
    );
  }, []);
  // The write report for the workspace's own writes (see `useTicketChanged`).
  const changed = useCallback(
    (updated: Ticket) => {
      patchTicket(updated);
      return wrote({ ticket: updated });
    },
    [patchTicket, wrote],
  );
  const statusAction = useBoardStatus({
    board,
    refresh,
    patchTicket,
    changed,
  });
  const total = counts ? counts.total : tickets.length;
  const selectedIndex = tickets.findIndex(
    (item) => item.reference === selected,
  );
  /** The selected ticket's place in the whole result. */
  const position =
    selectedIndex >= 0 ? { index: selectedIndex + 1, total } : null;
  function openAdjacent(direction: 1 | -1) {
    if (selectedIndex < 0) return;
    const next = tickets[selectedIndex + direction];
    if (next) {
      setSelected(next.reference);
    } else if (direction === 1 && tickets.length < total) {
      // The position stays put (and Next keeps focus) while more load.
      setPendingNext(selectedIndex + 1);
      setPages((value) => value + 1);
    }
  }
  /** Every reference the current search and filters match, across pages. */
  async function matchingReferences(): Promise<string[]> {
    const found = await readPages(
      filterArgs,
      Math.max(1, Math.ceil(total / PAGE_SIZE)),
    );
    return found.map((ticket) => ticket.reference);
  }
  const scopeName =
    navigation.kind === "trash"
      ? "Trash"
      : navigation.project === "unlinked"
        ? "No project"
        : navigation.project !== "all"
          ? (projects.find((p) => p.id === navigation.project)?.name ??
            "Project")
          : navigation.plan
            ? (plans.find((e) => e.id === navigation.plan)?.name ?? "Plan")
            : navigation.kind === "ready"
              ? "Ready"
              : navigation.kind === "progress"
                ? "In progress"
                : "All tickets";
  /**
   * Clears the filter dimensions back to the view's own scope. The search and
   * the source tabs are not filters: each clears with its own control (list
   * F-09).
   */
  function clearFilters() {
    setPlan(navigation.plan);
    setStatus(navigation.kind === "progress" ? "In progress" : "");
    setAvailability(navigation.kind === "ready" ? "Ready" : "");
    setTags("");
    setFamily("");
    setPages(1);
  }
  function scope(
    next: "all" | "ready" | "progress" | "trash",
    project = "all",
    planId = "",
  ) {
    // Trash lists only trashed tickets; an open ticket from another scope would
    // sit beside it as "outside the current results", so entering or leaving
    // Trash starts without a selection.
    if ((next === "trash") !== trash) selectTicket(null);
    // A new scope opens on its own list, not on a ticket left over from the
    // previous one (it would sit full-width as "outside the current results").
    if (
      next !== navigation.kind ||
      project !== navigation.project ||
      planId !== navigation.plan
    )
      setSelected(null);
    setNavigation({ kind: next, project, plan: planId });
    setView("tickets");
    setTrash(next === "trash");
    setFilter(project);
    setPlan(planId);
    setStatus(next === "progress" ? "In progress" : "");
    setAvailability(next === "ready" ? "Ready" : "");
    setTags("");
    setFamily("");
    setSourceFilter("all");
    setQuery("");
    setPages(1);
  }
  return {
    layout,
    board,
    statusAction,
    source,
    setSource,
    sourceCounts,
    configuredSources,
    sourceEntries,
    sourceRefresh,
    sourceHealth,
    refreshSources,
    projects,
    plans,
    plansKnown,
    plansFailure,
    refreshPlans,
    listKnown,
    filter,
    setFilter,
    query,
    setQuery,
    pages,
    resetPaging,
    showMore: () => setPages((value) => value + 1),
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
    trash,
    setTrash,
    tickets,
    counts,
    scopeTotal,
    total,
    grouped: !trash && !query,
    position,
    openAdjacent,
    selected,
    mention,
    clearMention,
    setSelected,
    opened,
    written,
    clearOpened,
    markMentionReady,
    error,
    setError,
    listFailure,
    loading,
    revision,
    refresh,
    create,
    patchTicket,
    scopeName,
    scope,
    navigation,
    clearFilters,
    queryError,
    refreshFailed,
  };
}
