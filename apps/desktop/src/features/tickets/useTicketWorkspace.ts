import { useCallback, useEffect, useRef, useState } from "react";
import {
  client,
  type FindFilter,
  type Project,
  type StatusCounts,
  type Ticket,
} from "@/lib/api/client";
import { loadPreferences } from "@/lib/preferences";
export const PAGE_SIZE = 50;
type View = "tickets" | "projects" | "efforts" | "settings" | "inbox";
export function statusTotal(counts: StatusCounts) {
  return (
    counts.todo +
    counts.in_progress +
    counts.in_review +
    counts.done +
    counts.canceled +
    counts.duplicate
  );
}
export type TicketWorkspace = ReturnType<typeof useTicketWorkspace>;
export function useTicketWorkspace(
  setView: (view: View) => void,
  setCreating: (value: boolean) => void,
) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [efforts, setEfforts] = useState<
    { id: string; name: string; archived: boolean }[]
  >([]);
  const [filter, setFilter] = useState("all");
  const [navigation, setNavigation] = useState<{
    kind: "all" | "ready" | "progress" | "trash";
    project: string;
    effort: string;
  }>({ kind: "all", project: "all", effort: "" });
  const [queryError, setQueryError] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [effort, setEffort] = useState("");
  const [status, setStatus] = useState("");
  const [tags, setTags] = useState("");
  const [availability, setAvailability] = useState("");
  const [family, setFamily] = useState("");
  const [trash, setTrash] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The counts describe the whole filtered result; they are null in Trash,
  // which lists tickets flat.
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  // The offset the displayed tickets were read at, for page-edge navigation.
  const [loadedOffset, setLoadedOffset] = useState(0);
  const [pendingEdge, setPendingEdge] = useState<"first" | "last" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Ticket>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
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
        effort: effort || null,
        status: status || null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        availability: availability || null,
        family: family || null,
        order: query ? "Newest" : "Workflow",
        limit: PAGE_SIZE,
        offset,
      };
      const result = await Promise.race([
        Promise.all([
          trash ? client.listTrash() : client.findTickets(filterArgs),
          client.listProjects(),
          client.listEfforts(),
          trash ? Promise.resolve(null) : client.countTickets(filterArgs),
        ]),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error("Timed out")),
            5000,
          );
        }),
      ]);
      if (request !== generation.current) return;
      setQueryError(false);
      setTickets(result[0]);
      setLoadedOffset(offset);
      setCounts(result[3]);
      setProjects(result[1]);
      setEfforts(result[2]);
      setRevision((value) => value + 1);
      setError("");
    } catch (reason) {
      if (request !== generation.current) return;
      setQueryError(true);
      setError(
        `Refresh failed: ${String(reason)}. Displayed information may be stale.`,
      );
    } finally {
      window.clearTimeout(timeout);
      if (request === generation.current) setLoading(false);
    }
  }, [
    trash,
    query,
    filter,
    offset,
    effort,
    status,
    tags,
    availability,
    family,
  ]);
  useEffect(() => {
    const generationRef = generation;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void refresh();
    }, 0);
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      generationRef.current++;
    };
  }, [refresh]);
  // Previous or Next at the edge of a page moves to the neighboring page and
  // opens the ticket at its near edge once that page has loaded.
  useEffect(() => {
    if (!pendingEdge || loadedOffset !== offset) return;
    const target = pendingEdge === "first" ? tickets[0] : tickets.at(-1);
    setPendingEdge(null);
    if (target) setSelected(target.reference);
  }, [pendingEdge, loadedOffset, offset, tickets]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const request = ++detailGeneration.current;
    void client.showTicket(selected).then(
      (ticket) => {
        if (active && request === detailGeneration.current)
          setDetails((previous) => ({
            ...previous,
            [ticket.reference]: ticket,
          }));
      },
      (reason: unknown) => {
        if (active) setError(`Ticket refresh failed: ${String(reason)}`);
      },
    );
    return () => {
      active = false;
    };
  }, [selected, revision]);
  async function create(
    title: string,
    body: string,
    status: string,
    project: string | null,
    effortId: string | null,
    tags: string[],
    keepOpen = false,
  ) {
    const ticket = await client.createTicket(
      title,
      body,
      status,
      project,
      effortId,
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
      items.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);
  const total = counts ? statusTotal(counts) : tickets.length;
  const selectedIndex = tickets.findIndex(
    (item) => item.reference === selected,
  );
  /** The selected ticket's place in the visible list, across pages. */
  const position =
    selectedIndex >= 0 && loadedOffset === offset
      ? { index: offset + selectedIndex + 1, total }
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
        ? "Unlinked"
        : navigation.project !== "all"
          ? (projects.find((p) => p.id === navigation.project)?.name ??
            "Project")
          : navigation.effort
            ? (efforts.find((e) => e.id === navigation.effort)?.name ??
              "Effort")
            : navigation.kind === "ready"
              ? "Ready"
              : navigation.kind === "progress"
                ? "In progress"
                : "All tickets";
  function clearFilters() {
    setQuery("");
    setEffort(navigation.effort);
    setStatus(navigation.kind === "progress" ? "In progress" : "");
    setAvailability(navigation.kind === "ready" ? "Ready" : "");
    setTags("");
    setFamily("");
    setOffset(0);
  }
  function scope(
    next: "all" | "ready" | "progress" | "trash",
    project = "all",
    effortId = "",
  ) {
    setNavigation({ kind: next, project, effort: effortId });
    setView("tickets");
    setTrash(next === "trash");
    setFilter(project);
    setEffort(effortId);
    setStatus(next === "progress" ? "In progress" : "");
    setAvailability(next === "ready" ? "Ready" : "");
    setTags("");
    setFamily("");
    setQuery("");
    setOffset(0);
  }
  return {
    projects,
    efforts,
    filter,
    setFilter,
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
    setTrash,
    tickets,
    counts,
    total,
    grouped: !trash && !query,
    position,
    openAdjacent,
    selected,
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
  };
}
