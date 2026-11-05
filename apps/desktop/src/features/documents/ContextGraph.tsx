import { useEffect, useMemo, useRef, useState } from "react";
import { type Viewport } from "@xyflow/react";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import { Button } from "@/components/ui/button";
import { client, type ContextGraph as Graph } from "@/lib/api/client";
import { GraphLegend, KindIcon } from "./GraphLegend";
import {
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
  onBack,
  onOpen,
}: {
  active?: boolean;
  origin: string;
  onBack: () => void;
  onOpen: (node: Graph["nodes"][number]) => void;
}) {
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
  }, [active, center, includeDetails, expandedIds, pages, changeVersion]);
  useEffect(() => {
    if (graph && restoreFocus.current) {
      restoreFocus.current = false;
      previewHeading.current?.focus();
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
      onBack();
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
  const showMap = opensAsMap(neighbours, mapChoice);
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
  const kindGroups = (["ticket", "document", "plan"] as const)
    .map((kind) => ({
      kind,
      nodes: (graph?.nodes ?? []).filter(
        (node) => node.id !== graph?.center && node.kind === kind,
      ),
    }))
    .filter((group) => group.nodes.length > 0);
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
  return (
    <section className="context-graph-page" aria-label="Context graph">
      <div className="context-graph-heading">
        <h1>Context graph</h1>
        <Button disabled={!preview} onClick={() => preview && onOpen(preview)}>
          Open selected item
        </Button>
      </div>
      <div className="context-graph-toolbar">
        <Button variant="ghost" onClick={back}>
          {history.length ? "Back" : "Back to source"}
        </Button>
        {centerLabel && (
          <span className="context-graph-scope">Centered on {centerLabel}</span>
        )}
        {neighbours > 0 && !tooDense && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMapChoice(!showMap)}
          >
            {showMap ? "Show list" : "Show map"}
          </Button>
        )}
        <label>
          <input
            type="checkbox"
            checked={includeDetails}
            onChange={(event) => {
              const include = event.target.checked;
              if (!include) {
                setExpandedIds([]);
                setPages([]);
                setGraph(null);
              }
              setIncludeDetails(include);
            }}
          />{" "}
          Include update details
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {layoutError && <p role="alert">{layoutError}</p>}
      {groupSummary && neighbours > 12 && (
        <p className="context-graph-groups">
          {groupSummary}
          {tooDense &&
            " · Too many connections for a map; use the list or center on an item."}
        </p>
      )}
      {!showMap && preview && (
        <div className="context-graph-strip">
          <span>{kindNames[preview.kind]}</span>
          <strong ref={previewHeading} tabIndex={-1}>
            {preview.label}
          </strong>
          <span>{stateLine(preview)}</span>
          {actions(preview)}
        </div>
      )}
      {showMap && (
        <div className="context-graph-main">
          {active && (
            <ContextGraphCanvas
              nodes={(graph?.nodes ?? []).map((node) => ({
                id: node.id,
                label: `${kindNames[node.kind].toUpperCase()} · ${node.label}`,
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
              onFitted={() => {
                setFit(false);
                setCenterOn(null);
              }}
            />
          )}
          <aside className="context-graph-preview">
            {preview ? (
              <>
                <p>{kindNames[preview.kind]}</p>
                <h2 ref={previewHeading} tabIndex={-1}>
                  {preview.label}
                </h2>
                <p>{stateLine(preview)}</p>
                {actions(preview)}
                <p>
                  Selecting previews an item. Center it to explore its
                  connections.
                </p>
              </>
            ) : (
              <p>Select an item to preview it.</p>
            )}
          </aside>
        </div>
      )}
      <div className="context-graph-toolbar">
        <GraphLegend />
      </div>
      {graph && (
        <p role="status" className="context-graph-status">
          Showing {graph.nodes.length}{" "}
          {graph.nodes.length === 1 ? "item" : "items"} · {graph.edges.length}{" "}
          {graph.edges.length === 1 ? "connection" : "connections"}
          {hiddenDetails ? " · update details hidden" : ""}
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
          {hiddenDetails && (
            <>
              {" "}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIncludeDetails(true)}
              >
                Show update details
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
        const limit = shownPerKind[group.kind] ?? GROUP_PAGE;
        return (
          <div key={group.kind}>
            <h3>
              {kindNames[group.kind]}s {group.nodes.length}
            </h3>
            <ul className="context-graph-list">
              {group.nodes.slice(0, limit).map((node) => (
                <li key={node.id}>
                  <KindIcon kind={node.kind} />
                  <button type="button" onClick={() => setSelected(node.id)}>
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
                    connectionRows(node.id, graph).map((row) => (
                      <p key={row.key}>
                        <strong>{edgeLabels[row.kind] ?? row.kind}</strong> ·{" "}
                        {row.text}
                      </p>
                    ))}
                </li>
              ))}
            </ul>
            {group.nodes.length > limit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setShownPerKind((value) => ({
                    ...value,
                    [group.kind]: limit + GROUP_PAGE,
                  }))
                }
              >
                Show {Math.min(GROUP_PAGE, group.nodes.length - limit)} more{" "}
                {kindNames[group.kind].toLowerCase()}s
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}
