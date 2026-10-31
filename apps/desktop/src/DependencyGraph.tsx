import { useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Position,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import { client, type DependencyGraph as Graph } from "./client";

export default function DependencyGraph({
  reference,
  revision,
  select,
}: {
  reference: string;
  revision: number;
  select: (reference: string, trashed: boolean) => void;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client.dependencyGraph(reference).then(
      (value) => {
        if (active) {
          setGraph(value);
          setError("");
        }
      },
      (reason: unknown) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [reference, revision]);
  if (error) return <p role="alert">Graph failed: {error}</p>;
  if (!graph) return <p role="status">Loading graph…</p>;
  const layout = new dagre.graphlib.Graph()
    .setGraph({ rankdir: "LR", nodesep: 30, ranksep: 60 })
    .setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes)
    layout.setNode(node.reference, { width: 180, height: 70 });
  for (const edge of graph.edges) layout.setEdge(edge.blocker, edge.dependent);
  dagre.layout(layout);
  const nodes = graph.nodes.map((node) => {
    const position = layout.node(node.reference) as { x: number; y: number };
    return {
      id: node.reference,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      position: { x: position.x - 90, y: position.y - 35 },
      data: {
        label: `${node.reference} ${node.title}\n${node.status}${node.trashed ? " · Trashed" : ""}${node.availability ? ` · ${node.availability}` : ""}`,
      },
      style: { width: 180, whiteSpace: "pre-wrap" as const },
    };
  });
  const edges = graph.edges.map((edge) => ({
    id: `${edge.blocker}-${edge.dependent}`,
    source: edge.blocker,
    target: edge.dependent,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  return (
    <section className="mt-5" aria-label="Dependency graph">
      <h3 className="font-semibold">Dependency graph</h3>
      <p>
        Arrow: blocker → dependent. Up to {graph.max_depth} links from{" "}
        {reference}, at most {graph.max_nodes} tickets.{" "}
        {graph.truncated && "Some relationships are outside this scope."}
      </p>
      <div style={{ height: 350 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={(_, node) => {
            const ticket = graph.nodes.find(
              (item) => item.reference === node.id,
            );
            if (ticket) select(ticket.reference, ticket.trashed);
          }}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <ul aria-label="Graph tickets">
        {graph.nodes.map((node) => (
          <li key={node.reference}>
            <button
              type="button"
              className="underline"
              onClick={() => select(node.reference, node.trashed)}
            >
              {node.reference} {node.title} · {node.status}
              {node.trashed && " · Trashed"}
              {node.availability && ` · ${node.availability}`}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
