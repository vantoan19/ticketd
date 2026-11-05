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
import { centerZoom, panToInclude, READABLE_ZOOM } from "./graph-text";
import { CARD_HEIGHT, CARD_WIDTH, type Point } from "./context-layout";
import "@xyflow/react/dist/style.css";

/** Low enough that a dense neighbourhood fits whole instead of being clipped. */
const MIN_ZOOM = 0.05;
/** A lone card must not be blown up to fill the view. */
const MAX_FIT_ZOOM = 1;

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
  centerId,
  centerOn = null,
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
  /** The item the layout puts in the middle. */
  centerId?: string | undefined;
  /** Ask the canvas to centre the viewport on this card at the current zoom; reported by onFitted. */
  centerOn?: string | null;
}) {
  const positionsRef = useRef(positions);
  const onPositionsRef = useRef(onPositions);
  const onErrorRef = useRef(onError);
  const centerIdRef = useRef(centerId);
  useEffect(() => {
    centerIdRef.current = centerId;
    positionsRef.current = positions;
    onPositionsRef.current = onPositions;
    onErrorRef.current = onError;
  }, [centerId, positions, onPositions, onError]);
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
      request: {
        ...request,
        center: centerIdRef.current,
        positions: positionsRef.current,
      },
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
    if ((!fit && !centerOn) || !placed || !ready) return;
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
      const target = centerOn ? positions[centerOn] : undefined;
      if (centerOn && target && instance.current) {
        // Centre on the card's middle without changing the zoom.
        void instance.current.setCenter(
          target.x + CARD_WIDTH / 2,
          target.y + CARD_HEIGHT / 2,
          { zoom: centerZoom(instance.current.getZoom()), duration: 200 },
        );
      } else {
        void instance.current?.fitView({
          padding: 0.2,
          duration: 200,
          // A map is only shown on request or when small, so it always opens at a
          // readable zoom and the person pans; a lone card is not enlarged.
          minZoom: READABLE_ZOOM,
          maxZoom: MAX_FIT_ZOOM,
        });
      }
      onFittedRef.current?.();
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [fit, centerOn, placed, ready, positions]);
  const container = useRef<HTMLDivElement | null>(null);
  // Cards that appear later (Expand, Load more) are panned into view; cards already
  // placed stay where they are.
  const placedIds = useRef<Set<string> | null>(null);
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  useEffect(() => {
    const now = new Set(nodes.filter((n) => positions[n.id]).map((n) => n.id));
    const before = placedIds.current;
    placedIds.current = now;
    if (!before || before.size === 0 || fit || centerOn || !ready) return;
    const added = [...now].filter((id) => !before.has(id));
    const element = container.current;
    if (!added.length || !element || !instance.current) return;
    const points = added.map((id) => positions[id]!);
    const x = Math.min(...points.map((p) => p.x));
    const y = Math.min(...points.map((p) => p.y));
    const right = Math.max(...points.map((p) => p.x)) + CARD_WIDTH;
    const bottom = Math.max(...points.map((p) => p.y)) + CARD_HEIGHT;
    const next = panToInclude(
      viewportRef.current,
      { width: element.clientWidth, height: element.clientHeight },
      { x, y, width: right - x, height: bottom - y },
    );
    if (next.x !== viewportRef.current.x || next.y !== viewportRef.current.y)
      void instance.current.setViewport(next, { duration: 200 });
  }, [positions, nodes, fit, centerOn, ready]);
  // Fit again when the panel is resized, so the map never stays clipped.
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let first = true;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () =>
          void instance.current?.fitView({
            padding: 0.2,
            duration: 200,
            minZoom: READABLE_ZOOM,
            maxZoom: MAX_FIT_ZOOM,
          }),
        150,
      );
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  // Labels crowd a dense map, so a line names itself only while hovered; the
  // item list states every connection in words.
  const [hovered, setHovered] = useState<string | null>(null);
  const shownEdges = useMemo(
    () =>
      edges.map((edge) =>
        edge.id === hovered ? edge : { ...edge, label: undefined },
      ),
    [edges, hovered],
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
          style: { width: CARD_WIDTH, minHeight: CARD_HEIGHT },
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
      ref={container}
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
        // The Connected items list is the keyboard path to every card.
        nodesFocusable={false}
        edgesFocusable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
