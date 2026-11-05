import { useEffect, useMemo, useRef, useState } from "react";
import { type Viewport } from "@xyflow/react";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import { Button } from "@/components/ui/button";
import { client, type ContextGraph as Graph } from "@/lib/api/client";
import { GraphLegend } from "./GraphLegend";
import { connectionRows, edgeLabels, flowEdges, kindNames } from "./graph-text";
import type { Point } from "./context-layout";
import "@xyflow/react/dist/style.css";
import "./context-graph.css";

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
  // Centering and going back unmount the control that had focus.
  const restoreFocus = useRef(false);
  const previewHeading = useRef<HTMLHeadingElement | null>(null);
  const [error, setError] = useState("");
  const [layoutError, setLayoutError] = useState("");
  useEffect(() => {
    if (!active) return;
    let live = true;
    let latest = 0;
    function refresh() {
      const request = ++latest;
      void client
        .contextGraphExpanded(center, includeDetails, expandedIds, pages)
        .then((value) => {
          if (!live || request !== latest) return;
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
          if (live && request === latest) setError(String(reason));
        });
    }
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [active, center, includeDetails, expandedIds, pages]);
  useEffect(() => {
    if (graph && restoreFocus.current) {
      restoreFocus.current = false;
      previewHeading.current?.focus();
    }
  }, [graph]);
  function focus(id: string) {
    restoreFocus.current = true;
    setFit(true);
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
  return (
    <section className="context-graph-page" aria-label="Context graph">
      <div className="context-graph-heading">
        <h1>Context graph</h1>
      </div>
      <div className="context-graph-toolbar">
        <Button variant="ghost" onClick={back}>
          {history.length ? "Back" : "Back to source"}
        </Button>
        {centerLabel && (
          <span className="context-graph-scope">Centered on {centerLabel}</span>
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
            onFitted={() => setFit(false)}
          />
        )}
        <aside className="context-graph-preview">
          {preview ? (
            <>
              <p>{kindNames[preview.kind]}</p>
              <h2 ref={previewHeading} tabIndex={-1}>
                {preview.label}
              </h2>
              <p>
                {preview.state}
                {preview.trashed ? " · Trashed" : ""}
                {preview.activity_detail ? " · Update details" : ""}
              </p>
              <Button onClick={() => onOpen(preview)}>Open item</Button>
              {preview.id !== graph?.center && (
                <>
                  <Button variant="outline" onClick={() => focus(preview.id)}>
                    Center on this item
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={expandedIds.includes(preview.id) || room === 0}
                    onClick={() =>
                      setExpandedIds((ids) => [...ids, preview.id])
                    }
                  >
                    Expand connections
                  </Button>
                  {(expandedIds.includes(preview.id) || room === 0) && (
                    <p>
                      {expandedIds.includes(preview.id)
                        ? "This item's connections are already shown."
                        : "View limit reached; center on an item to explore further."}
                    </p>
                  )}
                </>
              )}
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
      <ul className="context-graph-list">
        {graph?.nodes
          .filter((node) => node.id !== graph.center)
          .map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => setSelected(node.id)}>
                {node.label}
              </button>
              <Button variant="ghost" size="sm" onClick={() => focus(node.id)}>
                Center on {node.label}
              </Button>
              {connectionRows(node.id, graph).map((row) => (
                <p key={row.key}>
                  <strong>{edgeLabels[row.kind] ?? row.kind}</strong> ·{" "}
                  {row.text}
                </p>
              ))}
            </li>
          ))}
      </ul>
    </section>
  );
}
