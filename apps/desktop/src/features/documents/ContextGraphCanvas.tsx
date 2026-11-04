import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type Viewport,
} from "@xyflow/react";
import type { Point } from "./context-layout";
import "@xyflow/react/dist/style.css";

export function ContextGraphCanvas({
  nodes,
  edges,
  selected,
  positions,
  onPositions,
  viewport,
  onViewport,
  onSelect,
  onError,
}: {
  nodes: { id: string; label: string }[];
  edges: Edge[];
  selected: string | null;
  positions: Record<string, Point>;
  onPositions: (positions: Record<string, Point>) => void;
  viewport: Viewport;
  onViewport: (viewport: Viewport) => void;
  onSelect: (id: string) => void;
  onError: (error: string) => void;
}) {
  const positionsRef = useRef(positions);
  const onPositionsRef = useRef(onPositions);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    positionsRef.current = positions;
    onPositionsRef.current = onPositions;
    onErrorRef.current = onError;
  }, [positions, onPositions, onError]);
  const topology = JSON.stringify({
    nodes: nodes.map((node) => node.id).sort(),
    edges: edges
      .map(({ source, target }) => ({ source, target }))
      .sort((a, b) =>
        `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`),
      ),
  });
  const generation = useRef(0);
  useEffect(() => {
    const request = JSON.parse(topology) as {
      nodes: string[];
      edges: { source: string; target: string }[];
    };
    if (!request.nodes.length) return;
    const currentGeneration = generation;
    const id = ++currentGeneration.current;
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./context-layout.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (reason) {
      onErrorRef.current(`Graph layout failed: ${String(reason)}`);
      return;
    }
    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        positions?: Record<string, Point>;
        error?: string;
      }>,
    ) => {
      if (event.data.id !== currentGeneration.current) return;
      if (event.data.error)
        onErrorRef.current(`Graph layout failed: ${event.data.error}`);
      else if (event.data.positions)
        onPositionsRef.current(event.data.positions);
    };
    worker.onerror = (event) => {
      if (id === currentGeneration.current)
        onErrorRef.current(`Graph layout failed: ${event.message}`);
    };
    worker.postMessage({
      id,
      request: { ...request, positions: positionsRef.current },
    });
    return () => {
      currentGeneration.current++;
      worker.terminate();
    };
  }, [topology]);
  const flowNodes = useMemo<Node[]>(
    () =>
      nodes
        .filter((node) => positions[node.id])
        .map((node) => ({
          id: node.id,
          position: positions[node.id]!,
          data: { label: node.label },
          selected: node.id === selected,
        })),
    [nodes, positions, selected],
  );
  return (
    <div className="context-graph-canvas" aria-label="Connections canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        onNodeClick={(_, node) => onSelect(node.id)}
        viewport={viewport}
        onViewportChange={onViewport}
        nodesDraggable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
