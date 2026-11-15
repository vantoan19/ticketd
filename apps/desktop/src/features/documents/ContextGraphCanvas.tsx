import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
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
import { FileText, Layers } from "lucide-react";
import { GRAPH_ZOOM } from "@/components/ui/graph-zoom";
import {
  GraphCanvas,
  AvailabilityMark,
  GraphIsland,
  GraphLegend,
  GraphNodeCard,
  ZoomControls,
} from "@/components/ui/graph-kit";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  centerZoom,
  countNotFullyShown,
  edgeLineLabels,
  isUserMove,
  legendItems,
  panToInclude,
} from "./graph-text";
import { routeAll, type Rect } from "./edge-routing";
import { RoutedEdge } from "./RoutedEdge";
import { CARD_HEIGHT, CARD_WIDTH, type Point } from "./context-layout";
import "@xyflow/react/dist/style.css";

const MIN_ZOOM = GRAPH_ZOOM.min;
const MAX_ZOOM = GRAPH_ZOOM.max;
/** One press of the zoom buttons multiplies the zoom by this (React Flow's own step). */
const ZOOM_STEP = 1.2;
/** A lone card must not be blown up to fill the view. */
const MAX_FIT_ZOOM = 1;
/** Fit never zooms out past 100%, so card text stays legible; the user pans. */
const MIN_FIT_ZOOM = GRAPH_ZOOM.fit;
/** The container width at which Fit's margins are their full size. */
const FULL_MARGIN_WIDTH = 1000;

/**
 * Fit options for a container this wide. Margins shrink with a narrow window so
 * they do not swallow the canvas; top and bottom keep the legend row and the
 * zoom control clear of the cards.
 */
function fitOptions(width: number): FitViewOptions {
  const scale = Math.min(1, Math.max(0.4, width / FULL_MARGIN_WIDTH));
  return {
    padding: {
      top: "52px",
      right: `${Math.round(24 * scale)}px`,
      bottom: "56px",
      left: `${Math.round(24 * scale)}px`,
    },
    duration: 200,
    minZoom: MIN_FIT_ZOOM,
    maxZoom: MAX_FIT_ZOOM,
  };
}

type CardData = {
  ref: string;
  title: string;
  caption: string;
  kind: string;
  status: string;
  selected: boolean;
  availability?: string;
  variant?: "workspace" | "chip";
};

// Position's values are these strings.
const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * The graph kit's node card: icon, reference and state on line 1, the title
 * on line 2. The card is a button, so the map is reachable by keyboard; React
 * Flow's node click selects it. Handles are plumbing.
 */
function CardNode({ data }: NodeProps<Node<CardData>>) {
  return (
    <>
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
      <GraphNodeCard
        icon={
          data.kind === "plan" ? (
            <Layers aria-hidden="true" />
          ) : data.kind === "document" ? (
            <FileText aria-hidden="true" />
          ) : (
            <StatusIcon status={data.status || "Todo"} size={14} decorative />
          )
        }
        reference={data.ref}
        meta={data.caption}
        trailing={
          data.availability ? (
            <AvailabilityMark availability={data.availability} />
          ) : undefined
        }
        title={data.title}
        {...(data.variant && { variant: data.variant })}
        selected={data.selected}
        aria-pressed={data.selected}
      />
    </>
  );
}
export type WorkspaceIsland = {
  id: string;
  title: string;
  caption: string;
  icon?: ReactNode;
  x: number;
  y: number;
  width: number;
  height: number;
};
function IslandNode({
  data,
}: NodeProps<
  Node<{
    title: string;
    caption: string;
    icon?: ReactNode;
    onSelect: () => void;
  }>
>) {
  return (
    <>
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
      <GraphIsland
        title={data.title}
        caption={data.caption}
        icon={data.icon}
        onSelect={data.onSelect}
      />
    </>
  );
}
const NODE_TYPES = { card: CardNode, island: IslandNode };
const EDGE_TYPES = { routed: RoutedEdge };

export function ContextGraphCanvas({
  nodes,
  islands,
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
  loading = false,
  notice,
  footnote,
}: {
  nodes: {
    id: string;
    label: string;
    ref?: string;
    title?: string;
    caption?: string;
    kind?: string;
    status?: string;
    availability?: string;
    variant?: "workspace" | "chip";
  }[];
  islands?: WorkspaceIsland[];
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
  /** The items have not arrived yet: the canvas stays unseen rather than flashing an empty grid. */
  loading?: boolean;
  /** An empty or failed state centred in the canvas. */
  notice?: ReactNode;
  /** One caption beside the zoom control ("Showing 7 items · 9 connections"). */
  footnote?: ReactNode;
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
      .map(({ source, target, label }) => ({
        source,
        target,
        label: typeof label === "string" ? label : "",
      }))
      .sort((a, b) =>
        `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`),
      ),
  });
  const generation = useRef(0);
  useEffect(() => {
    if (islands) return;
    const request = JSON.parse(topology) as {
      nodes: string[];
      edges: { source: string; target: string; label: string }[];
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
      onErrorRef.current(
        reason instanceof Error ? reason.message : "The layout worker failed.",
      );
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
      if (event.data.error) onErrorRef.current(event.data.error);
      else if (event.data.positions)
        onPositionsRef.current(event.data.positions);
    };
    worker.onerror = (event) => {
      if (id === currentGeneration.current) onErrorRef.current(event.message);
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
  }, [topology, islands]);
  const instance = useRef<ReactFlowInstance | null>(null);
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  // Whether the view is still the one a fit chose. A resize refits only then;
  // a restored or user-moved view keeps its zoom and pan.
  const autoFitted = useRef(false);
  const onFittedRef = useRef(onFitted);
  useEffect(() => {
    onFittedRef.current = onFitted;
  }, [onFitted]);
  const placed = nodes.some((node) => positions[node.id]);
  const [ready, setReady] = useState(false);
  // The canvas stays hidden until its first fit is applied, so the map is never
  // seen at the starting zoom and then moved.
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  const revealFrame = useRef(0);
  useEffect(() => () => window.cancelAnimationFrame(revealFrame.current), []);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);
  // A fit that was asked for and not yet painted keeps the canvas hidden, even
  // after the parent has stopped asking (it clears `fit` as soon as the fit runs).
  const [fitting, setFitting] = useState(false);
  // Nothing asks for a fit (a restored view): there is nothing to wait for.
  const restored = !fit && !centerOn && placed && ready && !fitting;
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
      setFitting(!shownRef.current);
      const target = centerOn ? positions[centerOn] : undefined;
      if (centerOn && target && instance.current) {
        // Centre on the card's middle without changing the zoom.
        autoFitted.current = false;
        void instance.current.setCenter(
          target.x + CARD_WIDTH / 2,
          target.y + CARD_HEIGHT / 2,
          { zoom: centerZoom(instance.current.getZoom()), duration: 200 },
        );
        setFitting(false);
        setShown(true);
      } else {
        const options = fitOptions(
          container.current?.clientWidth || FULL_MARGIN_WIDTH,
        );
        // The first fit is not animated: it is applied before anything is shown.
        const first = !shownRef.current;
        autoFitted.current = true;
        const applied = instance.current?.fitView(
          first ? { ...options, duration: 0 } : options,
        );
        fitSized.current = sized;
        // Reveal once the viewport the fit chose has been painted into place.
        void Promise.resolve(applied).then(() => {
          revealFrame.current = window.requestAnimationFrame(() => {
            revealFrame.current = window.requestAnimationFrame(() => {
              setFitting(false);
              setShown(true);
            });
          });
        });
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
  const container = useRef<HTMLElement | null>(null);
  // Steps from the zoom the person sees, so repeated presses always move by one
  // step and never restart from a half-finished animation.
  const stepZoom = (factor: number) => {
    autoFitted.current = false;
    const next = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, viewportRef.current.zoom * factor),
    );
    void instance.current?.zoomTo(next, { duration: 0 });
  };
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
  const [size, setSize] = useState({ width: 0, height: 0 });
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
      setSize({ width: element.clientWidth, height: element.clientHeight });
      if (!autoFitted.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!autoFitted.current) return;
        void instance.current?.fitView(
          fitOptions(container.current?.clientWidth || FULL_MARGIN_WIDTH),
        );
      }, 150);
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
  // Cards cut by an edge count too: Fit at its legibility floor can clip a card
  // without hiding it, and the person should be told either way.
  const notFullyShown = countNotFullyShown(
    nodes.flatMap((node) => {
      const at = positions[node.id];
      return at
        ? [
            {
              ...at,
              width: sizes[node.id]?.width || CARD_WIDTH,
              height: Math.max(CARD_HEIGHT, sizes[node.id]?.height ?? 0),
            },
          ]
        : [];
    }),
    viewport,
    size,
  );
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
    for (const island of islands ?? []) {
      if (island.caption)
        cards[island.id] = {
          x: island.x + 16,
          y: island.y + 12,
          width: 216,
          height: 20,
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
    // A line names itself only beside the selected card, so labels never
    // pile up over the map; the legend and the panel name the rest.
    return edges.map((edge) => ({
      ...edge,
      ...(selected !== edge.source &&
        selected !== edge.target && {
          label: undefined,
        }),
      data: {
        ...edge.data,
        ...(routes[edge.id] && { route: routes[edge.id] }),
        ...(islands && {
          workspace: true,
          hot: selected === edge.source || selected === edge.target,
        }),
      },
    }));
  }, [edges, nodes, positions, sizes, selected, islands]);
  const flowNodes = useMemo<Node[]>(
    () => [
      ...(islands ?? []).map((island) => ({
        id: island.id,
        type: "island",
        position: { x: island.x, y: island.y },
        style: { width: island.width, height: island.height },
        measured: { width: island.width, height: island.height },
        data: {
          title: island.title,
          caption: island.caption,
          icon: island.icon,
          onSelect: () => onSelect(island.id),
        },
        selectable: false,
        zIndex: -1,
      })),
      ...nodes
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
              kind: node.kind ?? "ticket",
              status: node.status ?? "",
              selected: node.id === selected,
              availability: node.availability ?? "",
              ...(node.variant && { variant: node.variant }),
            },
            ariaLabel: node.label,
            style: {
              width: node.variant ? 216 : CARD_WIDTH,
              minHeight:
                node.variant === "chip" ? 28 : node.variant ? 60 : CARD_HEIGHT,
            },
            selected: node.id === selected,
            ...(measured?.width
              ? { measured }
              : node.variant
                ? {
                    measured: {
                      width: 216,
                      height: node.variant === "chip" ? 28 : 60,
                    },
                  }
                : {}),
          };
        }),
    ],
    [nodes, positions, selected, sizes, islands, onSelect],
  );
  const kindByLabel = Object.fromEntries(
    Object.entries(edgeLineLabels).map(([kind, label]) => [label, kind]),
  );
  const legend = legendItems(
    edges.map((edge) => {
      const kind = (edge.data as { kind?: string } | undefined)?.kind;
      return kind ?? kindByLabel[String(edge.label ?? "")] ?? "";
    }),
  );
  const fitAll = () => {
    autoFitted.current = true;
    void instance.current?.fitView(
      fitOptions(container.current?.clientWidth || FULL_MARGIN_WIDTH),
    );
  };
  return (
    <GraphCanvas
      ref={container}
      label="Connections canvas"
      data-variant={islands ? "workspace" : undefined}
      // Opacity, not visibility: React Flow marks each measured card
      // `visibility: visible`, which would show cards through a hidden
      // canvas while the edges, grid and zoom control are still waiting.
      data-pending={
        shown || restored || (!nodes.length && !loading) ? undefined : ""
      }
      legend={<GraphLegend items={legend} />}
      zoom={
        nodes.length > 0 && (
          <ZoomControls
            zoom={viewport.zoom}
            onZoomOut={() => stepZoom(1 / ZOOM_STEP)}
            onZoomIn={() => stepZoom(ZOOM_STEP)}
            onReset={() => {
              autoFitted.current = false;
              void instance.current?.zoomTo(1, { duration: 0 });
            }}
            onFit={fitAll}
            notInView={notFullyShown}
          />
        )
      }
      notice={notice}
      footnote={footnote}
    >
      <ReactFlow
        nodes={flowNodes}
        onNodesChange={rememberSizes}
        edges={shownEdges}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={(_, node) => {
          if (node.type !== "island") onSelect(node.id);
        }}
        onInit={(value) => {
          instance.current = value;
          setReady(true);
        }}
        viewport={viewport}
        onViewportChange={onViewport}
        onMoveStart={(event) => {
          // Only a pointer or wheel move is the person's own: Fit and the
          // controlled viewport syncing back also start moves, with no DOM event.
          if (isUserMove(event)) autoFitted.current = false;
        }}
        nodesDraggable={false}
        // Each card is a button of its own, so the node wrapper is not a stop.
        nodesFocusable={false}
        edgesFocusable={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={islands ? 20 : 16}
          size={1}
        />
      </ReactFlow>
    </GraphCanvas>
  );
}
