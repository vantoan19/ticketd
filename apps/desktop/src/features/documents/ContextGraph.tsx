import { useEffect, useMemo, useState } from "react";
import { type Edge, type Viewport } from "@xyflow/react";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import { Button } from "@/components/ui/button";
import { client, type ContextGraph as Graph } from "@/lib/api/client";
import type { Point } from "./context-layout";
import "@xyflow/react/dist/style.css";
import "./context-graph.css";

const edgeLabels: Record<string, string> = {
  blocks: "Blocks",
  membership: "Plan membership",
  document: "Plan document",
  spec: "Primary spec",
  mention: "References",
  activity: "Activity references",
  support: "Activity support",
};

export function ContextGraph({
  origin,
  onBack,
  onOpen,
}: {
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
  const [error, setError] = useState("");
  const [layoutError, setLayoutError] = useState("");
  useEffect(() => {
    let active = true;
    let latest = 0;
    function refresh() {
      const request = ++latest;
      void client
        .contextGraphExpanded(center, includeDetails, expandedIds, pages)
        .then((value) => {
          if (!active || request !== latest) return;
          setGraph(value);
          setSelected((previous) =>
            previous && value.nodes.some((node) => node.id === previous)
              ? previous
              : value.center,
          );
          setError("");
        })
        .catch((reason: unknown) => {
          if (active && request === latest) setError(String(reason));
        });
    }
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [center, includeDetails, expandedIds, pages]);
  function focus(id: string) {
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
  const edges = useMemo<Edge[]>(
    () =>
      (graph?.edges ?? []).map((edge, index) => ({
        id: `${index}`,
        source: edge.source,
        target: edge.target,
        label: edgeLabels[edge.kind] ?? edge.kind,
        animated: false,
        style:
          edge.kind === "mention" || edge.kind === "activity"
            ? { strokeDasharray: "5 5" }
            : {},
      })),
    [graph],
  );
  const preview = graph?.nodes.find((node) => node.id === selected);
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
        <span>
          {graph?.nodes.find((node) => node.id === graph.center)?.label}
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      {layoutError && <p role="alert">{layoutError}</p>}
      <div className="context-graph-main">
        <ContextGraphCanvas
          nodes={(graph?.nodes ?? []).map((node) => ({
            id: node.id,
            label: `${node.kind.toUpperCase()} · ${node.label}`,
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
        />
        <aside className="context-graph-preview">
          {preview ? (
            <>
              <p>{preview.kind}</p>
              <h2>{preview.label}</h2>
              <p>
                {preview.state}
                {preview.trashed ? " · Trashed" : ""}
                {preview.activity_detail ? " · Activity detail" : ""}
              </p>
              <Button onClick={() => onOpen(preview)}>Open item</Button>
              <Button
                variant="outline"
                disabled={
                  preview.id === graph?.center ||
                  expandedIds.includes(preview.id) ||
                  expandedIds.length + pages.length >= 8
                }
                onClick={() => setExpandedIds((ids) => [...ids, preview.id])}
              >
                Expand connections
              </Button>
              <Button
                variant="ghost"
                disabled={preview.id === graph?.center}
                onClick={() => focus(preview.id)}
              >
                Center on this item
              </Button>
              <p>
                Selection previews an item. Center to explore its connections.
              </p>
            </>
          ) : (
            <p>Select an item to preview it.</p>
          )}
        </aside>
      </div>
      <div className="context-graph-toolbar">
        <span>Blocks · References · Plan membership · Activity support</span>
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
          Include Activity details
        </label>
      </div>
      {graph?.omitted && (
        <p role="status">
          Some connections may be omitted because this view uses bounded checks:{" "}
          {graph.omitted_groups.join(", ")}.
        </p>
      )}
      {graph &&
        (graph.nodes.length >= graph.max_nodes ||
          graph.edges.length >= graph.max_edges) && (
          <p role="status">
            This view reached its limit. Center on an item to explore further.
          </p>
        )}
      {graph?.continuations.map((item) => {
        const anchor = graph.nodes.find((node) => node.id === item.anchor);
        return (
          <p key={`${item.anchor}:${item.group}`}>
            More {edgeLabels[item.kind] ?? item.kind} connections may exist for{" "}
            {anchor?.label ?? item.anchor}.{" "}
            {item.kind === "support" &&
            graph.hidden_details &&
            !includeDetails ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIncludeDetails(true)}
              >
                Show Activity details
              </Button>
            ) : item.next_offset !== null &&
              expandedIds.length + pages.length < 8 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setPages((previous) => [
                    ...previous,
                    {
                      anchor: item.anchor,
                      group: item.group,
                      offset: item.next_offset!,
                    },
                  ])
                }
              >
                Show more
              </Button>
            ) : (
              "View limit reached; center on an item to explore further."
            )}
          </p>
        );
      })}
      {graph?.hidden_details && (
        <p>
          Additional Activity details are hidden.{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIncludeDetails(true)}
          >
            Show Activity details
          </Button>
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
              {graph.edges
                .filter(
                  (edge) => edge.source === node.id || edge.target === node.id,
                )
                .map((edge, index) => (
                  <p key={index}>
                    {edgeLabels[edge.kind] ?? edge.kind}
                    {edge.explanation ? ` · ${edge.explanation}` : ""}
                  </p>
                ))}
            </li>
          ))}
      </ul>
    </section>
  );
}
