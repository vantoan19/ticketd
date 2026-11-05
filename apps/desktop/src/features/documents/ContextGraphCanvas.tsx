import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Background,
  Handle,
  ReactFlow,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeChange,
  type NodeProps,
  type Position,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { centerZoom, panToInclude } from "./graph-text";
import { GraphLegend } from "./GraphLegend";
import { routeAll, type Rect } from "./edge-routing";
import { RoutedEdge } from "./RoutedEdge";
import { CARD_HEIGHT, CARD_WIDTH, type Point } from "./context-layout";
import "@xyflow/react/dist/style.css";

/** Low enough that a dense neighbourhood fits whole instead of being clipped. */
const MIN_ZOOM = 0.05;
/** A lone card must not be blown up to fill the view. */
const MAX_FIT_ZOOM = 1;
/** Fit never zooms out past this, so card text stays legible; the user pans. */
const MIN_FIT_ZOOM = 0.5;
/** The container width at which Fit's margins are their full size. */
const FULL_MARGIN_WIDTH = 1000;

/**
 * Fit options for a container this wide. Margins shrink with a narrow window so
 * they do not swallow the canvas; the legend has its own row, so nothing needs
 * clearing on the right.
 */
function fitOptions(width: number): FitViewOptions {
  const scale = Math.min(1, Math.max(0.4, width / FULL_MARGIN_WIDTH));
  return {
    padding: {
      top: "32px",
      right: `${Math.round(32 * scale)}px`,
      bottom: "72px",
      left: `${Math.round(32 * scale)}px`,
    },
    duration: 200,
    minZoom: MIN_FIT_ZOOM,
    maxZoom: MAX_FIT_ZOOM,
  };
}

type CardData = { ref: string; title: string; caption: string };

// Position's values are these strings.
const SIDES = ["top", "right", "bottom", "left"] as const;

/** A status-neutral card: reference, title and kind beneath. Handles are plumbing. */
function CardNode({ data }: NodeProps<Node<CardData>>) {
  return (
    <div className="context-graph-card">
      {SIDES.map((side) => (
        <span key={side}>
          <Handle id={`in-${side}`} type="target" position={side as Position} />
          <Handle
            id={`out-${side}`}
            type="source"
            position={side as Position}
          />
        </span>
      ))}
      <span className="context-graph-card-title">
        {data.ref && <span className="context-graph-card-ref">{data.ref}</span>}{" "}
        {data.title}
      </span>
      <span className="context-graph-card-caption">{data.caption}</span>
    </div>
  );
}
const NODE_TYPES = { card: CardNode };
const EDGE_TYPES = { routed: RoutedEdge };

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
  overlay,
}: {
  nodes: {
    id: string;
    label: string;
    ref?: string;
    title?: string;
    caption?: string;
  }[];
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
  /** Shown under the legend, pinned to the canvas. */
  overlay?: ReactNode;
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
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
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
      // A canvas with no size yet (the pane is still laying out) cannot be fitted.
      const sized =
        !!container.current?.clientWidth && !!container.current?.clientHeight;
      if ((!measured || !sized) && tries++ < 60) {
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
        const options = fitOptions(
          container.current?.clientWidth || FULL_MARGIN_WIDTH,
        );
        void instance.current?.fitView(options);
        fitSized.current = sized;
        // The pane can still be settling (toolbar, side panel) on open; fit once
        // more so a card is never left cut at the edge.
        window.clearTimeout(settleTimer.current);
        settleTimer.current = window.setTimeout(
          () => void instance.current?.fitView({ ...options, duration: 0 }),
          400,
        );
      }
      onFittedRef.current?.();
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [fit, centerOn, placed, ready, positions]);
  const container = useRef<HTMLDivElement | null>(null);
  // Whether the opening fit ran against a canvas that had a measured size.
  const fitSized = useRef(false);
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
    // The cards that were in view before this change must not be pushed out of it.
    const view = viewportRef.current;
    const visible = [...before]
      .filter((id) => positions[id])
      .map((id) => positions[id]!)
      .filter((p) => {
        const left = p.x * view.zoom + view.x;
        const top = p.y * view.zoom + view.y;
        return (
          left + CARD_WIDTH * view.zoom > 0 &&
          left < element.clientWidth &&
          top + CARD_HEIGHT * view.zoom > 0 &&
          top < element.clientHeight
        );
      });
    const keep = visible.length
      ? {
          x: Math.min(...visible.map((p) => p.x)),
          y: Math.min(...visible.map((p) => p.y)),
          width:
            Math.max(...visible.map((p) => p.x)) +
            CARD_WIDTH -
            Math.min(...visible.map((p) => p.x)),
          height:
            Math.max(...visible.map((p) => p.y)) +
            CARD_HEIGHT -
            Math.min(...visible.map((p) => p.y)),
        }
      : undefined;
    const next = panToInclude(
      view,
      { width: element.clientWidth, height: element.clientHeight },
      { x, y, width: right - x, height: bottom - y },
      24,
      keep,
    );
    if (
      next.x !== viewportRef.current.x ||
      next.y !== viewportRef.current.y ||
      next.zoom !== viewportRef.current.zoom
    )
      void instance.current.setViewport(next, { duration: 200 });
  }, [positions, nodes, fit, centerOn, ready]);
  // Fit again when the panel is resized, so the map never stays clipped.
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      const sized = !!element.clientWidth && !!element.clientHeight;
      // The canvas just got its first real size: fit now, whatever ran before it.
      const late = sized && !fitSized.current && !!instance.current;
      if (late) fitSized.current = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () =>
          void instance.current?.fitView(
            fitOptions(container.current?.clientWidth || FULL_MARGIN_WIDTH),
          ),
        150,
      );
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  const [sizes, setSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  function rememberSizes(changes: NodeChange[]) {
    const seen = changes.flatMap((change) =>
      change.type === "dimensions" && change.dimensions
        ? [[change.id, change.dimensions] as const]
        : [],
    );
    if (seen.length)
      setSizes((before) => ({ ...before, ...Object.fromEntries(seen) }));
  }
  // Every line names its relationship. Lines bend around the cards in their way
  // and each label sits clear of every card and of the other labels.
  const shownEdges = useMemo<Edge[]>(() => {
    const cards: Record<string, Rect> = {};
    for (const node of nodes) {
      const at = positions[node.id];
      if (at)
        cards[node.id] = {
          x: at.x,
          y: at.y,
          width: sizes[node.id]?.width || CARD_WIDTH,
          height: Math.max(CARD_HEIGHT, sizes[node.id]?.height ?? 0),
        };
    }
    const routes = routeAll(
      cards,
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(typeof edge.label === "string" ? { label: edge.label } : {}),
      })),
    );
    return edges.map((edge) =>
      routes[edge.id] ? { ...edge, data: { route: routes[edge.id] } } : edge,
    );
  }, [edges, nodes, positions, sizes]);
  const flowNodes = useMemo<Node[]>(
    () =>
      nodes
        .filter((node) => positions[node.id])
        .map((node) => {
          // React Flow hides a card until it is measured, and it only measures
          // on a size change. A rebuilt node object (a renamed title) would
          // otherwise lose its size and stay hidden, so carry the size over.
          const measured = sizes[node.id];
          return {
            id: node.id,
            position: positions[node.id]!,
            type: "card",
            data: {
              label: node.label,
              ref: node.ref ?? "",
              title: node.title ?? node.label,
              caption: node.caption ?? "",
            },
            ariaLabel: node.label,
            style: { width: CARD_WIDTH, minHeight: CARD_HEIGHT },
            selected: node.id === selected,
            ...(measured?.width ? { measured } : {}),
          };
        }),
    [nodes, positions, selected, sizes],
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
    <div className="context-graph-stage">
      <div
        ref={container}
        className="context-graph-canvas"
        aria-label="Connections canvas"
        onKeyDown={selectFromKey}
      >
        <ReactFlow
          nodes={flowNodes}
          onNodesChange={rememberSizes}
          edges={shownEdges}
          minZoom={MIN_ZOOM}
          proOptions={{ hideAttribution: true }}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
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
        </ReactFlow>
        <div className="context-graph-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => void instance.current?.zoomOut({ duration: 150 })}
          >
            <Minus aria-hidden="true" />
          </button>
          <span aria-live="polite">{Math.round(viewport.zoom * 100)}%</span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => void instance.current?.zoomIn({ duration: 150 })}
          >
            <Plus aria-hidden="true" />
          </button>
          <span className="context-graph-zoom-rule" aria-hidden="true" />
          <button
            type="button"
            onClick={() =>
              void instance.current?.fitView(
                fitOptions(container.current?.clientWidth || FULL_MARGIN_WIDTH),
              )
            }
          >
            <Maximize aria-hidden="true" />
            Fit
          </button>
        </div>
      </div>
      <div className="context-graph-pinned">
        <GraphLegend />
        {overlay}
      </div>
    </div>
  );
}
