import { useCallback, useEffect, useRef, useState } from "react";
import { client, type Project, type Ticket } from "@/lib/api/client";
import { loadPreferences } from "@/lib/preferences";
import type { MentionTarget } from "./Backlinks";
type View = "tickets" | "projects" | "efforts" | "settings" | "inbox";
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
  const [revision, setRevision] = useState(0);
  // Moves only when the core reports a workspace write, so sections that cost
  // extra reads (Linked work, Backlinks) can skip an unchanged refresh.
  const [changes, setChanges] = useState(0);
  const changeToken = useRef<number | null>(null);
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
          // A write landing after this read moves the token at the next refresh.
          // An unreadable token must not fail the list refresh: it means unknown.
          client.changeToken().catch(() => null),
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
      // `null` is unknown, so it always counts as a change and is never kept.
      if (result[3] === null || changeToken.current !== result[3]) {
        changeToken.current = result[3];
        setChanges((value) => value + 1);
      }
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
    mention,
    clearMention,
    setSelected,
    details,
    setDetails,
    error,
    setError,
    loading,
    revision,
    changes,
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
