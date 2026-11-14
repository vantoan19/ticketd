import { useEffect, useEffectEvent } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { ZoomControl } from "@/components/ui/zoom-control";
import {
  READABLE_ZOOM,
  readableViewport,
  VIEW_MARGIN as MARGIN,
  ZOOM_ROOM,
} from "@/features/automations/canvas-layout";

/** Around a flow that fits with room to spare. */
const PADDING = 0.2;

/**
 * Keeps a flow in view and readable, for the editor and a run alike. The whole
 * flow is fitted when a step is added or removed (`shape`) and when the canvas
 * changes size, as when a panel opens beside it. A flow too wide or tall to
 * read whole is not shrunk to fit: it stays at a readable size, showing the
 * `selected` card with the start of its failure path, or else the `start`
 * cards (the top of the flow when there are none), and the rest is a scroll
 * away. The control zooms out further for whoever wants the overview. Whatever
 * takes focus on the canvas is brought into view.
 */
export function FlowView({
  shape,
  selected,
  start,
}: {
  shape: string;
  selected: string | null;
  /** What to show first while nothing is selected, as the steps a run reached. */
  start?: string[];
}) {
  const flow = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const zoom = useStore((state) => state.transform[2]);
  const canvas = useStore((state) => state.domNode);
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
    // A failure path leaves its step's side: show where it goes as well.
    const failure = flow
      .getEdges()
      .find(
        (edge) => edge.source === selected && edge.sourceHandle === "failure",
      );
    const ids = selected
      ? [selected, ...(failure ? [failure.target] : [])]
      : (start ?? []);
    const shown = nodes.filter((node) => ids.includes(node.id));
    const first = nodes[0];
    const focus = shown.length > 0 ? shown : first ? [first] : [];
    if (focus.length === 0) return;
    void flow.setViewport(
      readableViewport(
        bounds,
        flow.getNodesBounds(focus),
        { width, height },
        selected === null,
      ),
    );
  };
  // The card selected when the canvas resizes; choosing another card alone
  // leaves the view where the person put it.
  const refit = useEffectEvent(fit);
  useEffect(() => refit(), [shape, width, height]);
  // The canvas is moved by a transform, not scrolled, so the browser does not
  // bring a focused card or + into view by itself.
  useEffect(() => {
    if (!canvas) return;
    const reveal = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".react-flow__node"))
        return;
      const box = canvas.getBoundingClientRect();
      const item = target.getBoundingClientRect();
      const by = (low: number, high: number, from: number, to: number) =>
        from < low ? low - from : to > high ? high - to : 0;
      const dx = by(
        box.left + MARGIN,
        box.right - MARGIN,
        item.left,
        item.right,
      );
      const dy = by(
        box.top + MARGIN,
        box.bottom - ZOOM_ROOM,
        item.top,
        item.bottom,
      );
      if (dx === 0 && dy === 0) return;
      const view = flow.getViewport();
      void flow.setViewport({ ...view, x: view.x + dx, y: view.y + dy });
    };
    canvas.addEventListener("focusin", reveal);
    return () => canvas.removeEventListener("focusin", reveal);
  }, [canvas, flow]);
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
