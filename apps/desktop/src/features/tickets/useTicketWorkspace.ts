import { useCallback, useEffect, useRef, useState } from "react";
import { client, type Project, type Ticket } from "@/lib/api/client";
import { loadPreferences } from "@/lib/preferences";
type View = "tickets" | "projects" | "efforts" | "settings" | "inbox";
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
      const result = await Promise.race([
        Promise.all([
          trash
            ? client.listTrash()
            : client.findTickets({
                query,
                project:
                  filter === "all" || filter === "unlinked" ? null : filter,
                unlinked: filter === "unlinked",
                effort: effort || null,
                status: status || null,
                tags: tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                availability: availability || null,
                family: family || null,
                limit: 50,
                offset,
              }),
          client.listProjects(),
          client.listEfforts(),
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
