import { useEffect, useMemo, useRef, useState } from "react";
import { type Viewport } from "@xyflow/react";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import { Button } from "@/components/ui/button";
import { ListHeader } from "@/components/ui/list-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { client, type ContextGraph as Graph } from "@/lib/api/client";
import { useKeepPaneScroll } from "./keep-scroll";
import { KindIcon } from "./GraphLegend";
import {
  cardParts,
  nodeAriaLabel,
  connectionRows,
  edgeLabels,
  flowEdges,
  kindNames,
  MAP_LIMIT,
  opensAsMap,
  stateLine,
} from "./graph-text";
import { Crosshair } from "lucide-react";
import type { Point } from "./context-layout";
import "@xyflow/react/dist/style.css";
import { useWorkspaceChange } from "@/lib/workspace-change";
import "./context-graph.css";

const GROUP_PAGE = 10;

export function ContextGraph({
  active = true,
  origin,
  originLabel,
  onBack,
  onOpen,
}: {
  active?: boolean;
  origin: string;
  /** What Back returns to once the history is empty; defaults to the item the graph was opened from. */
  originLabel?: string;
  /** Gets the item the graph was opened from, so Back can return to it. */
  onBack: (origin: Graph["nodes"][number] | null) => void;
  onOpen: (node: Graph["nodes"][number]) => void;
}) {
  const keepScroll = useKeepPaneScroll();
  const changeVersion = useWorkspaceChange();
  const [center, setCenter] = useState(origin);
  const [selected, setSelected] = useState<string | null>(null);
  const [includeDetails, setIncludeDetails] = useState(false);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [pages, setPages] = useState<
    { anchor: string; group: number; offset: number }[]
  >([]);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [history, setHistory] = useState<
    {
      center: string;
      /** What Back names: the item that was centred when the view was left. */
      label: string;
      selected: string | null;
      includeDetails: boolean;
      expandedIds: string[];
      pages: { anchor: string; group: number; offset: number }[];
      positions: Record<string, Point>;
      viewport: Viewport;
    }[]
  >([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [fit, setFit] = useState(true);
  // Set by Center: put this card in the middle of the view at the current zoom.
  const [centerOn, setCenterOn] = useState<string | null>(null);
  // Centering and going back unmount the control that had focus.
  const restoreFocus = useRef(false);
  const previewHeading = useRef<HTMLHeadingElement | null>(null);
  // The item this graph was opened from; centring elsewhere does not change it.
  const [originNode, setOriginNode] = useState<Graph["nodes"][number] | null>(
    null,
  );
  const [error, setError] = useState("");
  const [layoutError, setLayoutError] = useState("");
  // Every change (token, centre, expansion) starts a request; only the newest
  // request's answer is applied, so a slow older answer never hides a newer one.
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const request = ++latestRequest.current;
    void client
      .contextGraphExpanded(center, includeDetails, expandedIds, pages)
      .then((value) => {
        if (!mounted.current || request !== latestRequest.current) return;
        setGraph(value);
        if (center === origin)
          setOriginNode(
            value.nodes.find((node) => node.id === value.center) ?? null,
          );
        // An expansion or page whose item is no longer shown has nothing to expand.
        const shown = new Set(value.nodes.map((node) => node.id));
        setExpandedIds((ids) =>
          ids.every((id) => shown.has(id))
            ? ids
            : ids.filter((id) => shown.has(id)),
        );
        setPages((items) =>
          items.every((item) => shown.has(item.anchor))
            ? items
            : items.filter((item) => shown.has(item.anchor)),
        );
        setSelected((previous) =>
          previous && value.nodes.some((node) => node.id === previous)
            ? previous
            : value.center,
        );
        setError("");
      })
      .catch((reason: unknown) => {
        if (mounted.current && request === latestRequest.current)
          setError(String(reason));
      });
  }, [
    active,
    center,
    origin,
    includeDetails,
    expandedIds,
    pages,
    changeVersion,
  ]);
  useEffect(() => {
    if (graph && restoreFocus.current) {
      restoreFocus.current = false;
      previewHeading.current?.focus({ preventScroll: true });
    }
  }, [graph]);
  function focus(id: string) {
    restoreFocus.current = true;
    setFit(false);
    setCenterOn(id);
    setHistory((entries) => [
      ...entries,
      {
        center,
        label:
          graph?.nodes.find((node) => node.id === graph.center)
            ?.ticket_reference ??
          centerLabel ??
          "previous item",
        selected,
        includeDetails,
        expandedIds,
        pages,
        positions,
        viewport,
      },
    ]);
    setGraph(null);
    setExpandedIds([]);
    setPages([]);
    setPositions({});
    setSelected(id);
    setCenter(id);
  }
  function back() {
    const previous = history.at(-1);
    if (!previous) {
      onBack(originNode);
      return;
    }
    restoreFocus.current = true;
    // Back returns to the exact view that was left, not a fresh fit.
    setFit(false);
    setCenterOn(null);
    setHistory((entries) => entries.slice(0, -1));
    setGraph(null);
    setExpandedIds(previous.expandedIds);
    setPages(previous.pages);
    setPositions(previous.positions);
    setSelected(previous.selected);
    setIncludeDetails(previous.includeDetails);
    setViewport(previous.viewport);
    setCenter(previous.center);
  }
  const edges = useMemo(() => flowEdges(graph?.edges ?? []), [graph]);
  const preview = graph?.nodes.find((node) => node.id === selected);
  // A crowded neighbourhood opens as a grouped list; the map is one click away.
  // The choice holds for the whole graph session, whichever item is centred.
  const neighbours = graph ? graph.nodes.length - 1 : 0;
  const [mapChoice, setMapChoice] = useState<boolean | null>(null);
  const tooDense = neighbours > MAP_LIMIT;
  // The automatic map/list choice is made once per centre and kept, so expanding
  // (or coming Back to that centre) must not flip the view.
  const [autoChoices, setAutoChoices] = useState<Record<string, boolean>>({});
  if (graph && autoChoices[graph.center] === undefined)
    setAutoChoices((choices) => ({
      ...choices,
      [graph.center]: opensAsMap(neighbours, null),
    }));
  const showMap =
    neighbours <= MAP_LIMIT &&
    (mapChoice ??
      (graph ? autoChoices[graph.center] : undefined) ??
      opensAsMap(neighbours, null));
  const [shownPerKind, setShownPerKind] = useState<Record<string, number>>({});
  // Items per relationship, so the summary counts the rows below it.
  const groupItems = new Map<string, Set<string>>();
  for (const edge of graph?.edges ?? [])
    if (edge.source === graph?.center || edge.target === graph?.center) {
      const other = edge.source === graph?.center ? edge.target : edge.source;
      const items = groupItems.get(edge.kind) ?? new Set<string>();
      items.add(other);
      groupItems.set(edge.kind, items);
    }
  const groupSummary = [...groupItems]
    .map(([kind, items]) => `${edgeLabels[kind] ?? kind} ${items.size}`)
    .join(" · ");
  const hiddenDetails = !!graph?.hidden_details && !includeDetails;
  // Support connections stay hidden until update details are shown.
  const pending = (graph?.continuations ?? []).filter(
    (item) => !(item.kind === "support" && hiddenDetails),
  );
  const loadable = pending.filter((item) => item.next_offset !== null);
  const room = Math.max(0, 8 - expandedIds.length - pages.length);
  const reachedLimit =
    !!graph &&
    (graph.nodes.length >= graph.max_nodes ||
      graph.edges.length >= graph.max_edges);
  const moreExists = pending.length > 0;
  const canLoadMore = loadable.length > 0 && room > 0 && !reachedLimit;
  const centerLabel = graph?.nodes.find(
    (node) => node.id === graph.center,
  )?.label;
  // Connected items group by how they connect to the centre, with the same
  // counts as the summary; items only reached through an expansion come last.
  const nodeById = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
  const relationGroups = [...groupItems]
    .map(([kind, items]) => ({
      key: kind,
      kind,
      title: edgeLabels[kind] ?? kind,
      nodes: [...items].flatMap((id) => nodeById.get(id) ?? []),
    }))
    .filter((group) => group.nodes.length > 0);
  const direct = new Set([...groupItems.values()].flatMap((set) => [...set]));
  const further = (graph?.nodes ?? []).filter(
    (node) => node.id !== graph?.center && !direct.has(node.id),
  );
  const kindGroups = [
    ...relationGroups,
    ...(further.length
      ? [
          {
            key: "further",
            kind: null,
            title: "Further connections",
            nodes: further,
          },
        ]
      : []),
  ];
  function actions(item: Graph["nodes"][number]) {
    if (item.id === graph?.center) return null;
    const expanded = expandedIds.includes(item.id);
    return (
      <>
        <Button variant="outline" onClick={() => focus(item.id)}>
          Center on this item
        </Button>
        <Button
          variant="ghost"
          disabled={expanded || room === 0}
          onClick={() => setExpandedIds((ids) => [...ids, item.id])}
        >
          Expand connections
        </Button>
        {(expanded || room === 0) && (
          <p>
            {expanded
              ? "This item's connections are already shown."
              : "View limit reached; center on an item to explore further."}
          </p>
        )}
      </>
    );
  }
  const relationships = graph?.edges.length ?? 0;
  const panel = preview ? (
    <>
      <p>{kindNames[preview.kind]}</p>
      <h2 ref={previewHeading} tabIndex={-1}>
        {preview.label}
      </h2>
      <p>{stateLine(preview)}</p>
      <Button onClick={() => onOpen(preview)}>Open item</Button>
      {actions(preview)}
      <p>Selecting previews an item. Center it to explore its connections.</p>
    </>
  ) : (
    <p>Select an item to preview it.</p>
  );
  return (
    <section className="context-graph-page" aria-label="Context graph">
      <ListHeader
        title="Context graph"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={back}>
              {history.length
                ? `Back to ${history.at(-1)!.label}`
                : `Back to ${originLabel ?? originNode?.ticket_reference ?? originNode?.label ?? "source"}`}
            </Button>
            <label className="context-graph-switch">
              <Switch
                aria-label="Include update details"
                checked={includeDetails}
                // Expand choices stay; ones whose item disappears are dropped
                // when the graph reloads.
                onCheckedChange={setIncludeDetails}
              />
              Update details
            </label>
            {neighbours > 0 && !tooDense && (
              <SegmentedControl
                aria-label="View"
                value={showMap ? "graph" : "list"}
                onValueChange={(value) => setMapChoice(value === "graph")}
                options={[
                  { value: "graph", label: "Graph" },
                  { value: "list", label: "List" },
                ]}
              />
            )}
          </>
        }
      >
        {centerLabel && (
          <span className="context-graph-subject">{centerLabel}</span>
        )}
        {graph && (
          <p>
            {graph.nodes.length} {graph.nodes.length === 1 ? "item" : "items"} ·{" "}
            {relationships}{" "}
            {relationships === 1 ? "relationship" : "relationships"}
          </p>
        )}
      </ListHeader>
      <div className="context-graph-body">
        {error && <p role="alert">{error}</p>}
        {layoutError && <p role="alert">{layoutError}</p>}
        {!showMap && preview && (
          <div className="context-graph-strip">
            <span>{kindNames[preview.kind]}</span>
            <strong ref={previewHeading} tabIndex={-1}>
              {preview.label}
            </strong>
            <span>{stateLine(preview)}</span>
            <Button onClick={() => onOpen(preview)}>Open item</Button>
            {actions(preview)}
          </div>
        )}
        {showMap && (
          <div className="context-graph-main">
            {active && (
              <ContextGraphCanvas
                nodes={(graph?.nodes ?? []).map((node) => ({
                  id: node.id,
                  label: nodeAriaLabel(node),
                  ...cardParts(node),
                  kind: node.kind,
                  status: node.state?.split(" · ")[0] ?? "",
                }))}
                edges={edges}
                selected={selected}
                positions={positions}
                onPositions={(value) => {
                  setLayoutError("");
                  setPositions(value);
                }}
                viewport={viewport}
                onViewport={setViewport}
                onSelect={setSelected}
                onError={setLayoutError}
                fit={fit}
                centerOn={centerOn}
                centerId={graph?.center}
                loading={!graph}
                onFitted={() => {
                  setFit(false);
                  setCenterOn(null);
                }}
              />
            )}
            <aside className="context-graph-preview">{panel}</aside>
          </div>
        )}
        {groupSummary && neighbours > 12 && (
          <p className="context-graph-groups">
            {groupSummary}
            {tooDense &&
              " · Too many connections for a map; use the list or center on an item."}
          </p>
        )}
        {graph && (
          <p role="status" className="context-graph-status">
            Showing {graph.nodes.length}{" "}
            {graph.nodes.length === 1 ? "item" : "items"} · {graph.edges.length}{" "}
            {graph.edges.length === 1 ? "connection" : "connections"}
            {hiddenDetails
              ? " · update details hidden; turn on Update details to show them"
              : ""}
            {moreExists && !canLoadMore
              ? " · View limit reached; center on an item to explore further"
              : ""}
            {canLoadMore && (
              <>
                {" · "}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPages((previous) => [
                      ...previous,
                      ...loadable.slice(0, room).map((item) => ({
                        anchor: item.anchor,
                        group: item.group,
                        offset: item.next_offset!,
                      })),
                    ])
                  }
                >
                  Load more
                </Button>
              </>
            )}
          </p>
        )}
        <h2>Connected items</h2>
        {graph && kindGroups.length === 0 && (
          <p role="status">
            Nothing is connected to this item yet. Mention it with T-n or attach
            it to a ticket to connect it.
          </p>
        )}
        {kindGroups.map((group) => {
          const limit = shownPerKind[group.key] ?? GROUP_PAGE;
          return (
            <div key={group.key}>
              <h3>
                {group.title}{" "}
                <span className="context-graph-count">
                  {group.nodes.length}
                </span>
              </h3>
              <ul className="context-graph-list">
                {group.nodes.slice(0, limit).map((node) => (
                  <li key={node.id}>
                    <KindIcon kind={node.kind} />
                    <button
                      type="button"
                      {...keepScroll(() => setSelected(node.id))}
                    >
                      {node.label}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Center on ${node.label}`}
                      title="Center on this item"
                      onClick={() => focus(node.id)}
                    >
                      <Crosshair aria-hidden="true" />
                    </Button>
                    {graph &&
                      connectionRows(node.id, graph)
                        .filter((row) => !group.kind || row.kind === group.kind)
                        .map((row) => (
                          <p key={row.key}>
                            <strong>{edgeLabels[row.kind] ?? row.kind}</strong>{" "}
                            · {row.text}
                          </p>
                        ))}
                  </li>
                ))}
              </ul>
              {group.nodes.length > limit && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Load more ${group.title}`}
                  onClick={() =>
                    setShownPerKind((value) => ({
                      ...value,
                      [group.key]: limit + GROUP_PAGE,
                    }))
                  }
                >
                  Load more
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
