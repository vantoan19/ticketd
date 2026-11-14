import { useEffect, useEffectEvent } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { ZoomControl } from "@/components/ui/zoom-control";

/** The smallest a flow is drawn without being asked: its cards still read. */
const READABLE_ZOOM = 0.75;
/** Around a flow that fits with room to spare. */
const PADDING = 0.2;
/** The least kept clear around a flow at its smallest readable size. */
const MARGIN = 16;
/** Above the first card when the flow is too tall to show whole. */
const TOP = 32;

/**
 * Keeps a flow in view and readable, for the editor and a run alike. The whole
 * flow is fitted when a step is added or removed (`shape`) and when the canvas
 * changes size, as when a panel opens beside it. A flow too wide or tall to
 * read whole is not shrunk to fit: it stays at a readable size, showing the
 * `selected` card, or its top, and the rest is a scroll away. The control
 * zooms out further for whoever wants the overview.
 */
export function FlowView({
  shape,
  selected,
}: {
  shape: string;
  selected: string | null;
}) {
  const flow = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const zoom = useStore((state) => state.transform[2]);
  const fit = () => {
    const nodes = flow.getNodes();
    const bounds = flow.getNodesBounds(nodes);
    const room = (side: number) => (side - 2 * MARGIN) / READABLE_ZOOM;
    if (bounds.width <= room(width) && bounds.height <= room(height))
      return void flow.fitView({
        minZoom: READABLE_ZOOM,
        maxZoom: 1,
        padding: PADDING,
      });
    const chosen = nodes.find((node) => node.id === selected);
    const card = chosen ?? nodes[0];
    if (!card) return;
    const x = card.position.x + (card.width ?? 0) / 2;
    const y = card.position.y + (card.height ?? 0) / 2;
    void flow.setViewport({
      x: width / 2 - x * READABLE_ZOOM,
      y: chosen
        ? height / 2 - y * READABLE_ZOOM
        : TOP - card.position.y * READABLE_ZOOM,
      zoom: READABLE_ZOOM,
    });
  };
  // The card selected when the canvas resizes; choosing another card alone
  // leaves the view where the person put it.
  const refit = useEffectEvent(fit);
  useEffect(() => refit(), [shape, width, height]);
  return (
    <div className="flow-zoom">
      <ZoomControl
        zoom={zoom}
        onZoomOut={() => void flow.zoomOut()}
        onZoomIn={() => void flow.zoomIn()}
        onFit={fit}
      />
    </div>
  );
}
