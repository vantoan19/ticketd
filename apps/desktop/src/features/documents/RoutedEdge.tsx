import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { pathFor, type Route } from "./edge-routing";

/** An edge drawn along a route computed around the cards, with its label placed clear of them. */
export function RoutedEdge({ id, markerEnd, style, data, label }: EdgeProps) {
  const route = (data as { route?: Route } | undefined)?.route;
  if (!route) return null;
  return (
    <>
      <BaseEdge
        id={id}
        path={pathFor(route.points)}
        {...(markerEnd ? { markerEnd } : {})}
        {...(style ? { style } : {})}
      />
      {typeof label === "string" && label && (
        <EdgeLabelRenderer>
          <span
            className="cgraph-edge-label nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`,
            }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
