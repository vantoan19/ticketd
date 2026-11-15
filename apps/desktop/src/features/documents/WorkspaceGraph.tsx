import { planWorkspaceGraph } from "@/features/plans/plan-workspace-graph";
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
import { Network, SearchX } from "lucide-react";
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
  opensAsMap,
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
import { Switch } from "@/components/ui/switch";
import {
  client,
  type WorkspaceGraph as Graph,
  type WorkspaceGraphRequest,
} from "@/lib/api/client";
import "@xyflow/react/dist/style.css";
import "./context-graph.css";

// Radix Select items cannot have an empty value.
const ALL = "__all__";
/** Most cards the map draws, so their text stays readable at the zoom it opens on. */
const MAP_CARDS = 12;
const RELATIONSHIPS = [
  "blocks",
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
const NO_POSITIONS: Record<string, Point> = {};
/** Ticket reference to project name ("" when it has none), shared by every mount. */
const projectOf = new Map<string, string>();

function projectName(node: { ticket_reference?: string | null | undefined }) {
  return (node.ticket_reference && projectOf.get(node.ticket_reference)) || "";
}

/** Connections among the shown items, or the item's own total when only one is shown. */
function connectionSummary(graph: Graph): string {
  const count = (n: number) => `${n} ${n === 1 ? "connection" : "connections"}`;
  const only = graph.nodes.length === 1 ? graph.nodes[0] : undefined;
  if (only) return `${count(graph.connection_counts?.[only.id] ?? 0)} in total`;
  return `${count(graph.edges.length)} among these items`;
}

export function WorkspaceGraph({
  planId = null,
  active,
  revision,
  onBack,
  onFocus,
  onOpen,
}: {
  planId?: string | null;
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
  const [selected, setSelected] = useState<string | null>(null);
  // A crowded workspace opens as a list; the map is one click away.
  const [mapChoice, setMapChoice] = useState<boolean | null>(null);
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
  // Bumped when more ticket projects are known, so cards and the panel redraw.
  const [projectsVersion, setProjectsVersion] = useState(0);
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
  // A new search or filter is a new map, not a continuation of the old one, so
  // positions only count for the request they were laid out for.
  const [placed, setPlaced] = useState<{
    request: WorkspaceGraphRequest;
    points: Record<string, Point>;
  }>({ request, points: {} });
  const positions = placed.request === request ? placed.points : NO_POSITIONS;
  const setPositions = (points: Record<string, Point>) =>
    setPlaced({ request, points });
  const currentRequest = useRef(request);
  useEffect(() => {
    currentRequest.current = request;
    cursors.current = [null];
    let active = true;
    void (
      planId
        ? planWorkspaceGraph(planId, request)
        : client.workspaceGraph(request)
    )
      .then((value) => {
        if (active) {
          setGraph(value);
          setFit(true);
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
    if (planId) {
      observedRevision.current = revision;
      let current = true;
      void planWorkspaceGraph(planId, request).then(
        (value) => {
          if (current) setGraph(value);
        },
        (reason: unknown) => {
          if (current)
            setError({
              failure: describeFailure(reason, "load the Plan graph"),
              retry: reload,
            });
        },
      );
      return () => {
        current = false;
      };
    }
    observedRevision.current = revision;
    if (!currentGraph.current) return;
    let current = true;
    async function hydrate(attempts: number) {
      const previous = currentGraph.current;
      if (!previous) return;
      const version = graphVersion.current;
      try {
        const value = await client.workspaceGraph({
          ...request,
          adjacency_limit: adjacencyLimit,
          visible_ids: previous.nodes.map((node) => node.id),
          hydrate_only: true,
        });
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
          !request.relationship &&
          previous.next_cursor === null &&
          previous.nodes.length < 100 &&
          value.total > value.nodes.length
        ) {
          const page = await client.workspaceGraph({
            ...request,
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
          next_cursor: previous.next_cursor,
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
  // A map of more than a couple of dozen cards cannot be read; it shows the newest.
  const mapNodes = useMemo(
    () => (graph?.nodes ?? []).slice(0, MAP_CARDS),
    [graph],
  );
  const shownEdges = useMemo(() => {
    const shown = new Set(mapNodes.map((node) => node.id));
    return (graph?.edges ?? []).filter(
      (edge) => shown.has(edge.source) && shown.has(edge.target),
    );
  }, [graph, mapNodes]);
  // Items with no relationship among the shown ones would only take canvas
  // space; they are listed beside the map instead.
  const [connected, unconnected] = useMemo(() => {
    const linked = new Set(shownEdges.flatMap((e) => [e.source, e.target]));
    return [
      mapNodes.filter((node) => linked.has(node.id)),
      mapNodes.filter((node) => !linked.has(node.id)),
    ];
  }, [mapNodes, shownEdges]);
  const nodes = useMemo(
    () =>
      connected.map((node) => {
        const parts = cardParts(node);
        return {
          id: node.id,
          label: nodeAriaLabel(node),
          ...parts,
          caption: [parts.caption, projectName(node)]
            .filter(Boolean)
            .join(" · "),
          kind: node.kind,
          status: statusOf(node),
        };
      }),
    // projectName reads projectOf, which projectsVersion tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connected, projectsVersion],
  );
  const edges = useMemo(() => flowEdges(shownEdges), [shownEdges]);
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
  // The graph carries no project, so each shown ticket's project is looked up
  // once from the existing ticket and project lists.
  const wanted = useMemo(
    () => [
      ...new Set(
        [...mapNodes, ...(preview ? [preview] : [])].flatMap((node) =>
          node.kind === "ticket" && node.ticket_reference
            ? [node.ticket_reference]
            : [],
        ),
      ),
    ],
    [mapNodes, preview],
  );
  useEffect(() => {
    const missing = wanted.filter((reference) => !projectOf.has(reference));
    if (!missing.length) return;
    let current = true;
    void (async () => {
      try {
        const names = new Map(
          ((await client.listProjects()) ?? []).map((item) => [
            item.id,
            item.name,
          ]),
        );
        await Promise.all(
          missing.map(async (reference) => {
            try {
              const ticket = await client.showTicket(reference);
              projectOf.set(
                reference,
                (ticket.project_id && names.get(ticket.project_id)) || "",
              );
            } catch {
              // A card without a project is still a card.
            }
          }),
        );
      } catch {
        return;
      }
      if (current) setProjectsVersion((n) => n + 1);
    })();
    return () => {
      current = false;
    };
  }, [wanted]);
  const showMap = opensAsMap(graph?.nodes.length ?? 0, mapChoice, Infinity);
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
      const page = await client.workspaceGraph({
        ...request,
        cursor: graph.next_cursor,
        adjacency_limit: adjacencyLimit,
        visible_ids: advance ? [] : graph.nodes.map((node) => node.id),
      });
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
        adjacency_limit: limit,
        visible_ids: graph.nodes.map((node) => node.id),
        hydrate_only: true,
      };
      const page = await (planId
        ? planWorkspaceGraph(planId, expansion)
        : client.workspaceGraph(expansion));
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
      {relationship && graph.nodes.length === 0
        ? `No connected items on this page${graph.next_cursor ? "; load more to search the rest" : ""}`
        : relationship
          ? `Showing ${graph.nodes.length} connected ${graph.nodes.length === 1 ? "item" : "items"} of ${graph.total}`
          : `Showing ${graph.nodes.length} of ${graph.total} ${graph.total === 1 ? "item" : "items"}`}{" "}
      · {connectionSummary(graph)}
      {showMap && graph.nodes.length > MAP_CARDS
        ? ` · The map shows the newest ${MAP_CARDS}`
        : ""}
      {planId &&
        graph.omitted_groups.includes("Plan connections across batches") && (
          <>
            {" "}
            · Some connections across the 100-item graph limit are hidden; open
            an item to see its connections
          </>
        )}
      {graph.omitted_groups.some(
        (group) => group !== "Plan connections across batches",
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
        (group) => group !== "Plan connections across batches",
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
            {...(linked(preview.id) && {
              onCenter: () => onFocus(preview.id),
            })}
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
      {showMap && unconnected.length > 0 && (
        <GraphPanelSection
          title="No links to other items"
          count={unconnected.length}
        >
          <ul className="cgraph-rows" aria-label="Not connected">
            {unconnected.map((node) => (
              <li key={node.id}>
                <GraphItemRow
                  node={node}
                  current={selected === node.id}
                  onSelect={() => setSelected(node.id)}
                />
              </li>
            ))}
          </ul>
        </GraphPanelSection>
      )}
    </GraphPanel>
  );
  const tagOptions = [...new Set([...(tag ? [tag] : []), ...knownTags])].map(
    (value) => ({ value, label: value }),
  );
  return (
    <section className="cgraph-page" aria-label="Workspace graph">
      <PaneHeader
        title="Workspace graph"
        count={
          graph && (
            <Count>
              {graph.nodes.length} {graph.nodes.length === 1 ? "item" : "items"}
            </Count>
          )
        }
        actions={
          <SegmentedControl
            aria-label="View"
            value={showMap ? "graph" : "list"}
            onValueChange={(value) => setMapChoice(value === "graph")}
            options={[
              { value: "graph", label: "Graph", disabled: empty },
              { value: "list", label: "List", disabled: empty },
            ]}
          />
        }
      />
      <div className="cgraph-filters" data-wrap="">
        {planId && (
          <span className="ui-graph-panel-caption">Filtered to this Plan</span>
        )}
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
      </div>
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
              positions={positions}
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
              onFitted={() => setFit(false)}
              notice={emptyState}
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
