import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import type { Point } from "./context-layout";
import "@xyflow/react/dist/style.css";

/** Low enough that a dense neighbourhood fits whole instead of being clipped. */
const MIN_ZOOM = 0.05;

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
  fit = false,
  onFitted,
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
  /** Ask the canvas to fit all items once positions exist; reported by onFitted. */
  fit?: boolean;
  onFitted?: () => void;
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
  const instance = useRef<ReactFlowInstance | null>(null);
  const onFittedRef = useRef(onFitted);
  useEffect(() => {
    onFittedRef.current = onFitted;
  }, [onFitted]);
  const placed = nodes.some((node) => positions[node.id]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!fit || !placed || !ready) return;
    // Fit only once React Flow has measured every card; fitting earlier centres
    // each card's corner instead of its middle.
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const measured =
        instance.current?.getNodes().every((node) => node.measured?.width) ??
        false;
      if (!measured && tries++ < 30) {
        frame = window.requestAnimationFrame(attempt);
        return;
      }
      void instance.current?.fitView({
        padding: 0.2,
        duration: 200,
        minZoom: MIN_ZOOM,
      });
      onFittedRef.current?.();
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [fit, placed, ready, positions]);
  // Labels crowd a dense map, so a line names itself only while hovered or
  // when it touches the selected item.
  const [hovered, setHovered] = useState<string | null>(null);
  const shownEdges = useMemo(
    () =>
      edges.map((edge) =>
        edge.id === hovered ||
        (selected !== null &&
          (edge.source === selected || edge.target === selected))
          ? edge
          : { ...edge, label: undefined },
      ),
    [edges, hovered, selected],
  );
  const flowNodes = useMemo<Node[]>(
    () =>
      nodes
        .filter((node) => positions[node.id])
        .map((node) => ({
          id: node.id,
          position: positions[node.id]!,
          data: { label: node.label },
          ariaLabel: node.label,
          selected: node.id === selected,
        })),
    [nodes, positions, selected],
  );
  // React Flow selects a focused node on Enter or Space without calling
  // onNodeClick, so the keyboard path reports the selection itself.
  function selectFromKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = (event.target as HTMLElement).closest(".react-flow__node");
    const id = element?.getAttribute("data-id");
    if (!id) return;
    event.preventDefault();
    onSelect(id);
  }
  return (
    <div
      className="context-graph-canvas"
      aria-label="Connections canvas"
      onKeyDown={selectFromKey}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={shownEdges}
        minZoom={MIN_ZOOM}
        proOptions={{ hideAttribution: true }}
        onEdgeMouseEnter={(_, edge) => setHovered(edge.id)}
        onEdgeMouseLeave={() => setHovered(null)}
        onNodeClick={(_, node) => onSelect(node.id)}
        onInit={(value) => {
          instance.current = value;
          setReady(true);
        }}
        viewport={viewport}
        onViewportChange={onViewport}
        nodesDraggable={false}
        edgesFocusable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
