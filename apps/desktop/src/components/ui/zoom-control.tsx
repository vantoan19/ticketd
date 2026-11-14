import type { ReactNode } from "react";
import { Maximize, Minus, Plus } from "lucide-react";

/**
 * One control for a canvas: zoom out, the percentage, zoom in, Fit. `children`
 * follow Fit, for what the canvas has to say about its view.
 */
export function ZoomControl({
  zoom,
  onZoomOut,
  onZoomIn,
  onFit,
  children,
}: {
  /** 1 is 100%. */
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="zoom-control" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={onZoomOut}>
        <Minus aria-hidden="true" />
      </button>
      <span aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in" onClick={onZoomIn}>
        <Plus aria-hidden="true" />
      </button>
      <span className="zoom-control-rule" aria-hidden="true" />
      <button type="button" onClick={onFit}>
        <Maximize aria-hidden="true" />
        Fit
      </button>
      {children}
    </div>
  );
}
