import { useEffect, useEffectEvent } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { ZoomControl } from "@/components/ui/zoom-control";
import {
  focusZoom,
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
 * `selected` card with the start of its failure path (shrunk to half at most,
 * so the two show together), or else the `start` cards (the top of the flow
 * when there are none), and the rest is a scroll away. The Fit button shows
 * the whole flow, as small as that takes. Whatever takes focus on the canvas
 * is brought into view.
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
  const minZoom = useStore((state) => state.minZoom);
  const canvas = useStore((state) => state.domNode);
  /** Fits the whole flow when it reads whole; says whether it did. */
  const fitReadable = () => {
    const bounds = flow.getNodesBounds(flow.getNodes());
    const room = (side: number) => (side - 2 * MARGIN) / READABLE_ZOOM;
    if (bounds.width > room(width) || bounds.height > room(height))
      return false;
    void flow.fitView({ minZoom: READABLE_ZOOM, maxZoom: 1, padding: PADDING });
    return true;
  };
  const fit = () => {
    if (fitReadable()) return;
    const nodes = flow.getNodes();
    const bounds = flow.getNodesBounds(nodes);
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
    const focusBox = flow.getNodesBounds(focus);
    void flow.setViewport(
      readableViewport(
        bounds,
        focusBox,
        { width, height },
        selected === null,
        // Shrunk, within limits, so the failure path shows beside its card.
        failure ? focusZoom(focusBox, { width, height }) : READABLE_ZOOM,
      ),
    );
  };
  /**
   * Fit, when asked for: the whole flow, every card, label and +, in the room
   * beside the panel, as small as that takes (down to the canvas's least).
   */
  const fitWhole = () =>
    fitReadable() ||
    void flow.fitView({
      minZoom,
      maxZoom: 1,
      padding: {
        top: `${MARGIN}px`,
        left: `${MARGIN}px`,
        right: `${MARGIN}px`,
        bottom: `${ZOOM_ROOM}px`,
      },
    });
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
      // The browser has already scrolled the canvas's clipped boxes to show
      // it, which the transform does not know of: undo that, then pan.
      for (
        let box: Element | null = target.parentElement;
        box && canvas.contains(box);
        box = box.parentElement
      ) {
        box.scrollLeft = 0;
        box.scrollTop = 0;
      }
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
        onFit={fitWhole}
      />
    </div>
  );
}
