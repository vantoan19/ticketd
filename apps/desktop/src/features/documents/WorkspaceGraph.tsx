import { PlanRing } from "@/features/plans/PlanProgress";
import type { PlanCounts } from "@/lib/api/plans";
import { WORKSPACE_GRAPH_COMMAND } from "./navigation";
import {
  workspacePlanIslands,
  planWorkspaceGraph,
} from "@/features/plans/plan-workspace-graph";
import { emptyCopy } from "@/lib/empty-copy";
import { EmptyState } from "@/components/ui/empty-state";
import {
  GraphPanel,
  GraphPanelActions,
  GraphPanelHead,
  GraphPanelSection,
} from "@/components/ui/graph-kit";
import { Reference } from "@/components/ui/reference";
import { SearchInput } from "@/components/ui/search-input";
import { Filter, Network, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Viewport } from "@xyflow/react";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import { GraphItemRow } from "./GraphItemRow";
import { KindIcon } from "./KindIcon";
import {
  labelledConnections,
  cardParts,
  nodeAriaLabel,
  edgeLabels,
  flowEdges,
  kindNames,
  openLabel,
  passageBetween,
  statusOf,
  stateLine,
} from "./graph-text";
import type { Point } from "./context-layout";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { layoutFailure } from "./graph-failure";
import { PaneHeader } from "@/components/ui/list-header";
import { Count } from "@/components/ui/count";
import { Picker } from "@/components/ui/picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import { Switch } from "@/components/ui/switch";
import {
  client,
  type WorkspaceGraph,
  type WorkspaceGraphRequest,
  type TicketMetadata,
} from "@/lib/api/client";
import "@xyflow/react/dist/style.css";
import "./context-graph.css";

type Graph = WorkspaceGraph & {
  structuralPlans?: WorkspaceGraph["nodes"];
  planMembership?: Record<string, string[]>;
  planCounts?: Record<string, PlanCounts>;
  availability?: Record<string, string | null>;
  partialTotal?: boolean;
  windowCursor?: string | null;
  ticketMetadata?: Record<string, TicketMetadata>;
};

// Radix Select items cannot have an empty value.
const ALL = "__all__";
const RELATIONSHIPS = [
  "blocks",
  "spec",
  "membership",
  "document",
  "mention",
  "attached",
  "activity",
  "support",
  "subticket",
  "related",
  "discovered",
];
/** Connections among the shown items, or the item's own total when only one is shown. */
function connectionSummary(graph: Graph): string {
  const count = (n: number) => `${n} ${n === 1 ? "connection" : "connections"}`;
  const only = graph.nodes.length === 1 ? graph.nodes[0] : undefined;
  if (only) return `${count(graph.connection_counts?.[only.id] ?? 0)} in total`;
  return `${count(graph.edges.length)} among these items`;
}

export function WorkspaceGraph({
  planId = null,
  projects = [],
  active,
  revision,
  onBack,
  onFocus,
  onOpen,
}: {
  planId?: string | null;
  projects?: readonly { id: string; name: string }[];
  active: boolean;
  revision: number;
  /** Leaves the graph for All tickets (the empty state's way out). */
  onBack: () => void;
  onFocus: (id: string) => void;
  onOpen: (node: Graph["nodes"][number]) => void;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [tag, setTag] = useState("");
  const [relationship, setRelationship] = useState("");
  const [includeDetails, setIncludeDetails] = useState(false);
  const [adjacencyLimit, setAdjacencyLimit] = useState(3);
  const cursors = useRef<(string | null)[]>([null]);
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [centerOn, setCenterOn] = useState<string | null>(null);
  // The ticket or island Center here brought into focus; Fit shows everything again.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mapChoice, setMapChoice] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    if (!active) return;
    const command = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (detail === "filter") setFiltersOpen(true);
      if (detail === "view") setMapChoice((value) => !value);
    };
    window.addEventListener(WORKSPACE_GRAPH_COMMAND, command);
    return () => window.removeEventListener(WORKSPACE_GRAPH_COMMAND, command);
  }, [active]);
  const [error, setError] = useState<{
    failure: FailureDescription;
    retry: () => void;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Bumped by Retry after a layout failure: a new canvas lays the graph out again.
  const [layoutRun, setLayoutRun] = useState(0);
  const reload = () => {
    setError(null);
    setAttempt((value) => value + 1);
  };
  const [loadingPage, setLoadingPage] = useState(false);
  const [fit, setFit] = useState(true);
  const [viewport, setViewport] = useState<Viewport>({
    x: 100,
    y: 100,
    zoom: 0.8,
  });
  const request = useMemo<WorkspaceGraphRequest>(
    () => ({
      cursor: null,
      search: search || null,
      kind: kind || null,
      tag: tag || null,
      relationship: relationship || null,
      include_details: includeDetails,
      adjacency_limit: 3,
      visible_ids: [],
      hydrate_only: false,
    }),
    [search, kind, tag, relationship, includeDetails],
  );
  const setPositions = () => {};
  const currentRequest = useRef(request);
  useEffect(() => {
    currentRequest.current = request;
    cursors.current = [null];
    let active = true;
    void (
      planId
        ? planWorkspaceGraph(planId, request)
        : workspacePlanIslands(request)
    )
      .then((value) => {
        if (active) {
          setGraph(value);
          setFit(true);
          setFocusId(null);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError({
            failure: describeFailure(reason, "load the workspace graph"),
            retry: reload,
          });
      });
    return () => {
      active = false;
    };
    // `attempt` reloads after Retry.
  }, [request, attempt, planId]);
  const currentGraph = useRef(graph);
  // Bumped whenever the shown pages change, so a slower refresh can tell its
  // snapshot of them is stale and must not overwrite newer pages.
  const graphVersion = useRef(0);
  useEffect(() => {
    currentGraph.current = graph;
    graphVersion.current += 1;
  }, [graph]);
  const observedRevision = useRef(revision);
  useEffect(() => {
    if (!active || revision === observedRevision.current) return;
    observedRevision.current = revision;
    if (!currentGraph.current) return;
    let current = true;
    async function hydrate(attempts: number) {
      const previous = currentGraph.current;
      if (!previous) return;
      const version = graphVersion.current;
      try {
        const refreshRequest = {
          ...request,
          cursor: previous.windowCursor ?? null,
          adjacency_limit: adjacencyLimit,
          visible_ids: previous.nodes.map((node) => node.id),
          hydrate_only: true,
        };
        const value = await (planId
          ? planWorkspaceGraph(planId, refreshRequest)
          : workspacePlanIslands(refreshRequest));
        if (!current || currentRequest.current !== request) return;
        if (graphVersion.current !== version) {
          // Pages were loaded meanwhile; refresh those instead of replacing them.
          if (attempts > 0) await hydrate(attempts - 1);
          return;
        }
        // Hydrating refreshes the items already shown and never adds new ones. If
        // everything was loaded and the workspace now counts more, something was
        // added meanwhile (the total is unaffected by a relationship filter, so
        // that case is left alone): load the first page again around what is shown.
        if (
          !planId &&
          !request.relationship &&
          previous.next_cursor === null &&
          previous.nodes.length < 100 &&
          value.total > value.nodes.length
        ) {
          const page = await workspacePlanIslands({
            ...request,
            cursor: previous.windowCursor ?? null,
            adjacency_limit: adjacencyLimit,
            visible_ids: previous.nodes.map((node) => node.id),
            hydrate_only: false,
          });
          if (!current || currentRequest.current !== request) return;
          if (graphVersion.current !== version) {
            if (attempts > 0) await hydrate(attempts - 1);
            return;
          }
          setGraph(page);
          return;
        }
        setGraph({
          ...value,
          next_cursor: planId ? value.next_cursor : previous.next_cursor,
          omitted: value.omitted || previous.next_cursor !== null,
        });
      } catch (reason: unknown) {
        if (current)
          setError({
            failure: describeFailure(reason, "load the workspace graph"),
            retry: reload,
          });
      }
    }
    void hydrate(2);
    return () => {
      current = false;
    };
  }, [active, revision, request, adjacencyLimit, planId]);
  // Every loaded item has the same representation in Graph and List. Plan
  // identities are the island labels; membership is independent of edge caps.
  const mapNodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const shownEdges = useMemo(() => graph?.edges ?? [], [graph]);
  const planCounts = graph?.planCounts;
  const planMembership = graph?.planMembership;
  const islandLayout = useMemo(() => {
    const points: Record<string, Point> = {};
    const islands: import("./ContextGraphCanvas").WorkspaceIsland[] = [];
    const plans =
      graph?.structuralPlans ?? mapNodes.filter((node) => node.kind === "plan");
    const membership = new Map<string, string[]>(
      Object.entries(planMembership ?? {}),
    );
    for (const edge of shownEdges) {
      if (
        ["membership", "document", "spec"].includes(edge.kind) &&
        plans.some((plan) => plan.id === edge.source)
      ) {
        const owners = membership.get(edge.target) ?? [];
        owners.push(edge.source);
        membership.set(edge.target, owners);
      }
    }
    let top = 24;
    const placed = new Set<string>();
    for (const plan of plans) {
      const members = mapNodes.filter((node) =>
        membership.get(node.id)?.includes(plan.id),
      );
      if (!members.length && !mapNodes.some((node) => node.id === plan.id))
        continue;
      const tickets = members.filter((node) => node.kind === "ticket").length;
      const documents = members.filter(
        (node) => node.kind === "document",
      ).length;
      const height = Math.max(124, 48 + Math.ceil(members.length / 3) * 96);
      islands.push({
        id: plan.id,
        title: plan.label,
        ...(planCounts?.[plan.id] && {
          icon: (
            <PlanRing
              name={plan.label}
              counts={planCounts[plan.id]!}
              decorative
            />
          ),
        }),
        caption: `${tickets} ${tickets === 1 ? "ticket" : "tickets"}, ${documents} ${documents === 1 ? "Document" : "Documents"}`,
        x: 24,
        y: top,
        width: 760,
        height,
        memberIds: members.map((node) => node.id),
      });
      points[plan.id] = { x: 40, y: top + 12 };
      members.forEach((node, index) => {
        // Documents can belong to more than one Plan. Draw one identity and
        // retain all its membership connections in the side panel.
        if (!placed.has(node.id))
          points[node.id] = {
            x: 48 + (index % 3) * 248,
            y: top + 48 + Math.floor(index / 3) * 96,
          };
        placed.add(node.id);
      });
      top += height + 24;
    }
    const loose = mapNodes.filter(
      (node) => node.kind !== "plan" && !placed.has(node.id),
    );
    if (loose.length) {
      islands.push({
        id: "__unplanned__",
        title: `${loose.some((node) => planMembership?.[node.id] === undefined || (planMembership[node.id]?.length ?? 0) > 0) ? "Plan membership not loaded" : "Not in a Plan"} · ${loose.length}`,
        caption: "",
        x: 24,
        y: top,
        width: 760,
        height: 48 + Math.ceil(loose.length / 3) * 40,
      });
      loose.forEach((node, index) => {
        points[node.id] = {
          x: 48 + (index % 3) * 248,
          y: top + 40 + Math.floor(index / 3) * 40,
        };
      });
    }
    return { islands, points, loose: new Set(loose.map((node) => node.id)) };
  }, [
    mapNodes,
    shownEdges,
    planCounts,
    graph?.structuralPlans,
    planMembership,
  ]);
  const availability = graph?.availability;
  const nodes = useMemo(
    () =>
      mapNodes
        .filter((node) => node.kind !== "plan")
        .map((node) => {
          const parts = cardParts(node);
          return {
            id: node.id,
            label: nodeAriaLabel(node),
            ...parts,
            caption:
              node.kind === "document"
                ? shownEdges.some(
                    (edge) => edge.kind === "spec" && edge.target === node.id,
                  )
                  ? "Spec of the Plan"
                  : "Document"
                : node.state === "Todo"
                  ? ""
                  : (node.state ?? ""),
            kind: node.kind,
            status: statusOf(node),
            availability: availability?.[node.id] ?? "",
            variant: islandLayout.loose.has(node.id)
              ? ("chip" as const)
              : ("workspace" as const),
          };
        }),
    [mapNodes, islandLayout, availability, shownEdges],
  );
  // Plan wells express membership and linked Documents without a web of
  // structural lines; every relationship remains named in the selection panel.
  const edges = useMemo(
    () =>
      flowEdges(
        shownEdges.filter(
          (edge) => !["membership", "document"].includes(edge.kind),
        ),
      ),
    [shownEdges],
  );
  const [knownTags, setKnownTags] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    void Promise.resolve()
      .then(() => client.searchTags(""))
      .then((tags) => {
        if (current) setKnownTags(tags);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [revision]);
  const preview = graph?.nodes.find((node) => node.id === selected);
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const projectName = (node: { id: string }) => {
    const id = graph?.ticketMetadata?.[node.id]?.project_id;
    return (id && projectNames.get(id)) || "";
  };
  const showMap = mapChoice;
  const filtered = !!(search || kind || tag || relationship);
  function refine(change: () => void) {
    change();
    setAdjacencyLimit(3);
    setPagesLoaded(1);
  }
  function clearFilters() {
    setSearch("");
    setKind("");
    setTag("");
    setRelationship("");
    setAdjacencyLimit(3);
    setPagesLoaded(1);
  }
  const more = async () => {
    if (!graph?.next_cursor || loadingPage) return;
    setLoadingPage(true);
    const advance = pagesLoaded >= 4 || graph.nodes.length >= 100;
    try {
      const page = await (planId
        ? planWorkspaceGraph(planId, {
            ...request,
            cursor: graph.next_cursor,
            adjacency_limit: adjacencyLimit,
            visible_ids: [],
          })
        : workspacePlanIslands({
            ...request,
            cursor: graph.next_cursor,
            adjacency_limit: adjacencyLimit,
            visible_ids: advance ? [] : graph.nodes.map((node) => node.id),
          }));
      if (currentRequest.current !== request) return;
      if (advance) {
        cursors.current = [graph.next_cursor];
        setPagesLoaded(1);
      } else {
        cursors.current.push(graph.next_cursor);
        setPagesLoaded((count) => count + 1);
      }
      setGraph(page);
    } catch (reason: unknown) {
      setError({
        failure: describeFailure(reason, "show more of the graph"),
        retry: () => void more(),
      });
    } finally {
      setLoadingPage(false);
    }
  };
  const expandConnections = async () => {
    if (loadingPage || !graph) return;
    const limit = Math.min(adjacencyLimit * 2, 12);
    setLoadingPage(true);
    try {
      const expansion = {
        ...request,
        cursor: graph.windowCursor ?? null,
        adjacency_limit: limit,
        visible_ids: graph.nodes.map((node) => node.id),
        hydrate_only: true,
      };
      const page = await (planId
        ? planWorkspaceGraph(planId, expansion)
        : workspacePlanIslands(expansion));
      if (currentRequest.current !== request) return;
      setGraph({
        ...page,
        next_cursor: graph.next_cursor,
        omitted: page.omitted || graph.next_cursor !== null,
      });
      setAdjacencyLimit(limit);
    } catch (reason: unknown) {
      setError({
        failure: describeFailure(reason, "show more connections"),
        retry: () => void expandConnections(),
      });
    } finally {
      setLoadingPage(false);
    }
  };
  const connectionsOf = (id: string) => graph?.connection_counts?.[id] ?? 0;
  const linked = (id: string) =>
    connectionsOf(id) > 0 ||
    !!graph?.edges.some((edge) => edge.source === id || edge.target === id);
  const empty = !!graph && graph.nodes.length === 0 && !graph.next_cursor;
  const statusText = graph && (
    <>
      {graph.partialTotal
        ? `Showing ${graph.nodes.length} loaded items`
        : relationship && graph.nodes.length === 0
          ? `No connected items on this page${graph.next_cursor ? "; load more to search the rest" : ""}`
          : relationship
            ? `Showing ${graph.nodes.length} connected ${graph.nodes.length === 1 ? "item" : "items"} of ${graph.total}`
            : `Showing ${graph.nodes.length} of ${graph.total} ${graph.total === 1 ? "item" : "items"}`}{" "}
      · {connectionSummary(graph)}
      {graph.omitted_groups.includes("Plan island window") && (
        <> · Some Plan islands are not loaded; Load more shows another window</>
      )}
      {graph.omitted_groups.includes("Plan member window") && (
        <>
          {" "}
          · Some Plan tickets or Documents are not loaded; Load more shows
          another window
        </>
      )}
      {graph.omitted_groups.includes("Plan filter window") && (
        <>
          {" "}
          · Some matching items are outside this search window; Load more
          searches the rest
        </>
      )}
      {graph.omitted_groups.includes("Workspace node window") && (
        <>
          {" "}
          · Some items are outside the 250-item window; Load more shows the rest
        </>
      )}
      {graph.omitted_groups.some(
        (group) =>
          ![
            "Plan island window",
            "Plan member window",
            "Plan filter window",
            "Workspace node window",
          ].includes(group),
      ) &&
        adjacencyLimit < 12 && (
          <>
            {" · "}
            <Button
              variant="link"
              size="sm"
              disabled={loadingPage}
              onClick={() => void expandConnections()}
            >
              Show more connections
            </Button>
          </>
        )}
      {graph.omitted_groups.some(
        (group) =>
          ![
            "Plan island window",
            "Plan member window",
            "Plan filter window",
            "Workspace node window",
          ].includes(group),
      ) &&
        adjacencyLimit >= 12 && (
          <> · Some connections are hidden; open an item to see all</>
        )}
      {graph.next_cursor && (
        <>
          {" · "}
          <Button
            variant="link"
            size="sm"
            disabled={loadingPage}
            onClick={() => void more()}
          >
            Load more
          </Button>
        </>
      )}
    </>
  );
  const emptyState = empty && (
    <EmptyState
      role="status"
      anchor="center"
      icon={filtered ? <SearchX /> : <Network />}
      title={
        filtered
          ? "No items match these filters"
          : emptyCopy("workspace-graph").title
      }
      description={
        filtered
          ? kind && relationship
            ? "A connection to an item of another type is not shown while Type is set."
            : "Clear the filters to see the whole workspace."
          : emptyCopy("workspace-graph").sentence
      }
      action={
        filtered ? (
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onBack}>
            {emptyCopy("workspace-graph").action}
          </Button>
        )
      }
    />
  );
  const previewParts = preview ? cardParts(preview) : null;
  const panel = !empty && (
    <GraphPanel
      label="Selected item"
      footer={
        preview && (
          <GraphPanelActions
            openLabel={openLabel(preview)}
            onOpen={() => onOpen(preview)}
            onCenter={() => {
              setMapChoice(true);
              setCenterOn(preview.id);
              setFocusId(preview.id);
            }}
          />
        )
      }
    >
      {preview && previewParts ? (
        <>
          <GraphPanelHead
            icon={<KindIcon kind={preview.kind} status={statusOf(preview)} />}
            eyebrow={
              previewParts.ref ? (
                <Reference>{previewParts.ref}</Reference>
              ) : (
                kindNames[preview.kind]
              )
            }
            title={previewParts.title}
            caption={[
              stateLine(preview),
              ...(graph?.edges ?? [])
                .filter(
                  (edge) =>
                    edge.target === preview.id &&
                    ["membership", "document", "spec"].includes(edge.kind),
                )
                .map(
                  (edge) =>
                    graph?.nodes.find((node) => node.id === edge.source)?.label,
                ),
              projectName(preview),
              graph?.node_tags[preview.id],
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          {labelledConnections(preview.id, graph!).map((row) => (
            <GraphPanelSection
              key={row.label}
              title={row.label}
              count={row.items.length}
            >
              <ul className="cgraph-rows">
                {row.items.flatMap((item) => {
                  const node = graph?.nodes.find((each) => each.id === item.id);
                  return node
                    ? [
                        <li key={node.id}>
                          <GraphItemRow
                            node={node}
                            current={false}
                            {...(passageBetween(
                              preview.id,
                              node.id,
                              graph!,
                            ) && {
                              caption: passageBetween(
                                preview.id,
                                node.id,
                                graph!,
                              ),
                            })}
                            onSelect={() => setSelected(node.id)}
                          />
                        </li>,
                      ]
                    : [];
                })}
              </ul>
            </GraphPanelSection>
          ))}
          {connectionsOf(preview.id) >
            labelledConnections(preview.id, graph!).reduce(
              (sum, row) => sum + row.items.length,
              0,
            ) && (
            <p className="cgraph-caption" data-inline="">
              {connectionsOf(preview.id)}{" "}
              {connectionsOf(preview.id) === 1 ? "connection" : "connections"}{" "}
              in total
            </p>
          )}
        </>
      ) : (
        <p className="cgraph-caption" data-inline="">
          Select an item to see its connections.
        </p>
      )}
    </GraphPanel>
  );
  const tagOptions = [...new Set([...(tag ? [tag] : []), ...knownTags])].map(
    (value) => ({ value, label: value }),
  );
  const filterControls = (
    <>
      <SearchInput
        className="w-60 max-w-full"
        aria-label="Search"
        placeholder="Search items…"
        value={search}
        onValueChange={(value) => refine(() => setSearch(value))}
      />
      <Picker
        label="Type"
        value={kind || ALL}
        onValueChange={(value) =>
          refine(() => setKind(value === ALL ? "" : value))
        }
        options={[
          { value: ALL, label: "All" },
          { value: "ticket", label: "Tickets" },
          { value: "document", label: "Documents" },
          { value: "plan", label: "Plans" },
        ]}
      />
      <Picker
        label="Relationship"
        value={relationship || ALL}
        onValueChange={(value) =>
          refine(() => setRelationship(value === ALL ? "" : value))
        }
        options={[
          { value: ALL, label: "All" },
          ...RELATIONSHIPS.map((value) => ({
            value,
            label: edgeLabels[value] ?? value,
          })),
        ]}
      />
      <Picker
        label="Tag"
        value={tag || ALL}
        onValueChange={(value) =>
          refine(() => setTag(value === ALL ? "" : value))
        }
        options={[{ value: ALL, label: "Any" }, ...tagOptions]}
      />
      {/* The empty state carries its own Clear filters; one is enough. */}
      {filtered && !empty && (
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      )}
      <label className="cgraph-switch">
        <Switch
          aria-label="Include update details"
          checked={includeDetails}
          onCheckedChange={(checked) =>
            refine(() => setIncludeDetails(checked))
          }
        />
        Update details
      </label>
    </>
  );
  return (
    <section
      className="cgraph-page"
      aria-label="Workspace graph"
      aria-busy={!graph && !error}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
          return;
        if (matchesShortcut(event, "workspace-graph-filter")) {
          event.preventDefault();
          setFiltersOpen((value) => !value);
        }
        if (matchesShortcut(event, "workspace-graph-view")) {
          event.preventDefault();
          setMapChoice((value) => !value);
        }
      }}
    >
      <PaneHeader
        variant="responsive"
        title="Workspace graph"
        count={
          graph && (
            <Count>
              {graph.nodes.length} {graph.nodes.length === 1 ? "item" : "items"}{" "}
              · {graph.edges.length}{" "}
              {graph.edges.length === 1 ? "connection" : "connections"}
            </Count>
          )
        }
        actions={
          <>
            <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
              <Tooltip
                content={`Filter · ${shortcutLabel("workspace-graph-filter")}`}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-keyshortcuts={ariaKeyShortcuts(
                      "workspace-graph-filter",
                    )}
                  >
                    <Filter aria-hidden="true" />
                    Filter
                  </Button>
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent align="end" className="w-80">
                <div className="cgraph-workspace-filters">{filterControls}</div>
              </PopoverContent>
            </Popover>
            <Tooltip
              content={`Switch Graph / List · ${shortcutLabel("workspace-graph-view")}`}
            >
              <div>
                <SegmentedControl
                  aria-label="View"
                  value={showMap ? "graph" : "list"}
                  onValueChange={(value) => setMapChoice(value === "graph")}
                  options={[
                    { value: "graph", label: "Graph", disabled: empty },
                    { value: "list", label: "List", disabled: empty },
                  ]}
                />
              </div>
            </Tooltip>
          </>
        }
      />
      {planId && (
        <p className="cgraph-scope ui-graph-panel-caption">
          Filtered to this Plan
        </p>
      )}

      {error && (
        <FailureAlert
          size="compact"
          className="mx-4 mt-2 flex-none"
          failure={error.failure}
          onRetry={error.retry}
        />
      )}
      <div className="cgraph-body">
        {showMap || empty ? (
          active && (
            <ContextGraphCanvas
              key={layoutRun}
              nodes={nodes}
              edges={edges}
              loading={!graph}
              selected={selected}
              islands={islandLayout.islands}
              positions={islandLayout.points}
              onPositions={setPositions}
              viewport={viewport}
              onViewport={setViewport}
              onSelect={setSelected}
              onError={(details) =>
                setError({
                  failure: layoutFailure(details),
                  retry: () => {
                    setError(null);
                    setLayoutRun((value) => value + 1);
                  },
                })
              }
              fit={fit}
              centerOn={centerOn}
              focusId={focusId}
              onShowAll={() => setFocusId(null)}
              onFitted={() => {
                setFit(false);
                setCenterOn(null);
              }}
              notice={
                !graph && !error ? (
                  <p role="status" className="ui-graph-panel-caption">
                    Loading workspace graph…
                  </p>
                ) : (
                  emptyState
                )
              }
              footnote={!empty && statusText}
            />
          )
        ) : (
          <div className="cgraph-scroll">
            {graph && <p className="cgraph-caption">{statusText}</p>}
            <h2 className="sr-only">Items</h2>
            <ul className="cgraph-rows">
              {graph?.nodes.map((node) => (
                <li key={node.id}>
                  <GraphItemRow
                    node={node}
                    current={selected === node.id}
                    caption={[cardParts(node).caption, projectName(node)]
                      .filter(Boolean)
                      .join(" · ")}
                    onSelect={() => setSelected(node.id)}
                    {...(linked(node.id) && {
                      onFocus: () => onFocus(node.id),
                    })}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
        {panel}
      </div>
    </section>
  );
}
