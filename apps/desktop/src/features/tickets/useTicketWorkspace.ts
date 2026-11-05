import { useCallback, useEffect, useRef, useState } from "react";
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
import { loadPreferences } from "@/lib/preferences";
import {
  useOnWorkspaceChange,
  useWorkspaceChange,
} from "@/lib/workspace-change";
import type { MentionTarget } from "./Backlinks";
export const PAGE_SIZE = 50;
type View = "tickets" | "projects" | "plans" | "settings" | "inbox";
/**
 * A mention being followed. It is not `ready` until the selected ticket has been
 * fetched after the selection, so it is judged against the stored text rather than
 * a cached copy.
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
  const lastSnapshot = useRef("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
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
  // The offset the displayed tickets were read at, for page-edge navigation.
  const [loadedOffset, setLoadedOffset] = useState(0);
  const [pendingEdge, setPendingEdge] = useState<"first" | "last" | null>(null);
  const [selected, selectTicket] = useState<string | null>(null);
  const [mention, setMention] = useState<FollowedMention | null>(null);
  // Counts every selection, including of the ticket already open, so each one
  // fetches the ticket afresh.
  const [selections, setSelections] = useState(0);
  // Every selection ends the previous mention; following a backlink starts one.
  const setSelected = useCallback(
    (reference: string | null, target?: MentionTarget) => {
      selectTicket(reference);
      setMention(target ? { ...target, key: Date.now(), ready: false } : null);
      setSelections((count) => count + 1);
    },
    [],
  );
  const clearMention = useCallback(() => setMention(null), []);
  const [details, setDetails] = useState<Record<string, Ticket>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [listRevision, setRevision] = useState(0);
  // The list only changes when a listed ticket does, but a Document, Activity or
  // another ticket can change what the open ticket's page shows. Pages key their
  // reads on this revision, so it also moves with every workspace change.
  const revision = listRevision + useWorkspaceChange();
  // Advances on every successful poll, changed data or not, for views that poll their own sources.
  const [pollTick, setPollTick] = useState(0);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  // Only the scope's own fields matter to a fetch; depending on the object would
  // refetch whenever the same scope is chosen again.
  const scopeKind = navigation.kind;
  const scopePlan = navigation.plan;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    let timeout = 0;
    try {
      // A search lists newest first, like Trash; every other list is grouped by
      // status, so it pages through workflow order.
      const filterArgs: FindFilter = {
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
        offset,
      };
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
          trash ? client.listTrash() : client.findTickets(filterArgs),
          client.listProjects(),
          client.listPlans(),
          trash ? Promise.resolve(null) : client.countTickets(filterArgs),
          // Source counts only decorate the filter, so they never fail the list.
          trash
            ? Promise.resolve(null)
            : client.countBySource(filterArgs).catch(() => null),
          trash || scoped
            ? Promise.resolve(null)
            : client.countTickets(unfiltered).catch(() => null),
        ]),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error("Timed out")),
            5000,
          );
        }),
      ]);
      if (request !== generation.current) return;
      const found = result[3];
      if (!trash && found && offset > 0 && offset >= found.total) {
        // The page this view was on no longer exists (its last tickets left the
        // result): go to the last page that does instead of showing an empty list
        // under a non-zero total.
        setOffset(
          found.total === 0
            ? 0
            : Math.floor((found.total - 1) / PAGE_SIZE) * PAGE_SIZE,
        );
        return;
      }
      listLoaded.current = true;
      setPollTick((value) => value + 1);
      setQueryError(false);
      setRefreshFailed(false);
      setError("");
      // The same data again changes nothing, so views are not told to reload.
      const snapshot = JSON.stringify([trash, offset, result]);
      if (snapshot === lastSnapshot.current) return;
      lastSnapshot.current = snapshot;
      setTickets(result[0]);
      setLoadedOffset(offset);
      setCounts(result[3]);
      setSourceCounts(result[4]);
      setScopeTotal(result[5]?.total ?? null);
      setProjects(result[1]);
      setPlans(result[2]);
      setRevision((value) => value + 1);
    } catch (reason) {
      if (request !== generation.current) return;
      lastSnapshot.current = "";
      if (listLoaded.current) setRefreshFailed(true);
      else {
        setQueryError(true);
        setError(
          `Refresh failed: ${String(reason)}. Displayed information may be stale.`,
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (request === generation.current) setLoading(false);
    }
  }, [
    trash,
    query,
    filter,
    offset,
    plan,
    status,
    tags,
    availability,
    family,
    source,
    scopeKind,
    scopePlan,
  ]);
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
  // Previous or Next at the edge of a page moves to the neighboring page and
  // opens the ticket at its near edge once that page has loaded.
  if (pendingEdge && loadedOffset === offset) {
    const target = pendingEdge === "first" ? tickets[0] : tickets.at(-1);
    setPendingEdge(null);
    if (target) setSelected(target.reference);
  }
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const request = ++detailGeneration.current;
    void client.showTicket(selected).then(
      (ticket) => {
        if (active && request === detailGeneration.current) {
          setDetails((previous) => ({
            ...previous,
            [ticket.reference]: ticket,
          }));
          setMention((current) => markReady(current, ticket.reference));
        }
      },
      (reason: unknown) => {
        if (!active) return;
        setError(`Ticket refresh failed: ${String(reason)}`);
        // Reveal against what is cached rather than never.
        setMention((current) => markReady(current, selected));
      },
    );
    return () => {
      active = false;
    };
  }, [selected, revision, selections]);
  // Trashing or restoring swaps the ticket's view; a mention does not outlive that.
  const trashed = selected ? details[selected]?.trashed : undefined;
  const [seen, setSeen] = useState<{
    reference: string;
    trashed: boolean;
  } | null>(null);
  if (selected && trashed !== undefined) {
    if (seen?.reference !== selected || seen.trashed !== trashed) {
      setSeen({ reference: selected, trashed });
      if (seen?.reference === selected) setMention(null);
    }
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
        error: reason instanceof Error ? reason.message : String(reason),
        errorAt: new Date().toISOString(),
      });
    }
    await refresh();
  }
  function setSource(next: string) {
    setSourceFilter(next);
    setOffset(0);
  }
  async function create(
    title: string,
    body: string,
    status: string,
    project: string | null,
    planId: string | null,
    tags: string[],
    keepOpen = false,
  ) {
    const ticket = await client.createTicket(
      title,
      body,
      status,
      project,
      planId,
      tags,
      loadPreferences().followCreated,
    );
    setDetails((previous) => ({ ...previous, [ticket.reference]: ticket }));
    if (!keepOpen) {
      setCreating(false);
      setSelected(ticket.reference);
    }
    await refresh();
    return ticket.reference;
  }
  const updateTicket = useCallback((updated: Ticket) => {
    generation.current++;
    detailGeneration.current++;
    setDetails((items) => ({ ...items, [updated.reference]: updated }));
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
  const total = counts ? counts.total : tickets.length;
  const selectedIndex = tickets.findIndex(
    (item) => item.reference === selected,
  );
  /**
   * The selected ticket's place in the visible list, across pages. It is read
   * against the page that is loaded, so it stays put (and the Previous/Next
   * buttons stay mounted, keeping focus) while the neighboring page loads.
   */
  const position =
    selectedIndex >= 0
      ? { index: loadedOffset + selectedIndex + 1, total }
      : null;
  function openAdjacent(direction: 1 | -1) {
    if (selectedIndex < 0) return;
    const next = tickets[selectedIndex + direction];
    if (next) {
      setSelected(next.reference);
    } else if (direction === 1 && offset + tickets.length < total) {
      setPendingEdge("first");
      setOffset(offset + PAGE_SIZE);
    } else if (direction === -1 && offset > 0) {
      setPendingEdge("last");
      setOffset(Math.max(0, offset - PAGE_SIZE));
    }
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
  function clearFilters() {
    setQuery("");
    setPlan(navigation.plan);
    setStatus(navigation.kind === "progress" ? "In progress" : "");
    setAvailability(navigation.kind === "ready" ? "Ready" : "");
    setTags("");
    setFamily("");
    setSourceFilter("all");
    setOffset(0);
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
    // Another Plan opens on its own list, not on the previous Plan's open ticket.
    if (planId && planId !== navigation.plan) setSelected(null);
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
    setOffset(0);
  }
  return {
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
    filter,
    setFilter,
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
    details,
    setDetails,
    error,
    setError,
    loading,
    revision,
    refresh,
    create,
    updateTicket,
    scopeName,
    scope,
    navigation,
    clearFilters,
    queryError,
    refreshFailed,
  };
}
