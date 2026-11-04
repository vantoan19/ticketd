import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { client, type ContextGraph as Graph } from "@/lib/api/client";
import "@xyflow/react/dist/style.css";
import "./context-graph.css";

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
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client
      .contextGraph(center, includeDetails)
      .then((value) => {
        if (active) {
          setGraph(value);
          setSelected(value.center);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [center, includeDetails]);
  const nodes = useMemo<Node[]>(
    () =>
      (graph?.nodes ?? []).map((node, _index, all) => {
        const count = Math.max(all.length - 1, 1);
        const neighbors = all.filter((item) => item.id !== graph?.center);
        const position = neighbors.findIndex((item) => item.id === node.id);
        const angle = (2 * Math.PI * Math.max(position, 0)) / count;
        return {
          id: node.id,
          position:
            node.id === graph?.center
              ? { x: 400, y: 240 }
              : {
                  x: 400 + 300 * Math.cos(angle),
                  y: 240 + 180 * Math.sin(angle),
                },
          data: { label: `${node.kind.toUpperCase()} · ${node.label}` },
          selected: node.id === selected,
        };
      }),
    [graph, selected],
  );
  const edges = useMemo<Edge[]>(
    () =>
      (graph?.edges ?? []).map((edge, index) => ({
        id: `${index}`,
        source: edge.source,
        target: edge.target,
        label: edge.kind,
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
        <Button variant="ghost" onClick={onBack}>
          Back to source
        </Button>
        <span>
          {graph?.nodes.find((node) => node.id === graph.center)?.label}
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="context-graph-main">
        <div className="context-graph-canvas" aria-label="Connections canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={(_, node) => setSelected(node.id)}
            fitView
            nodesDraggable={false}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
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
                variant="ghost"
                disabled={preview.id === graph?.center}
                onClick={() => setCenter(preview.id)}
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
            onChange={(event) => setIncludeDetails(event.target.checked)}
          />{" "}
          Include Activity details
        </label>
      </div>
      {graph?.omitted && (
        <p role="status">
          Some connections may be omitted because this view uses bounded checks.
        </p>
      )}
      {graph?.hidden_details && (
        <p>
          Additional Activity details are hidden. Include Activity details to
          show them.
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
              {graph.edges
                .filter(
                  (edge) => edge.source === node.id || edge.target === node.id,
                )
                .map((edge, index) => (
                  <p key={index}>
                    {edge.kind}
                    {edge.explanation ? ` · ${edge.explanation}` : ""}
                  </p>
                ))}
            </li>
          ))}
      </ul>
    </section>
  );
}
