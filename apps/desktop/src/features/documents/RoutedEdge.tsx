import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { pathFor, type Route } from "./edge-routing";

/** An edge drawn along a route computed around the cards, with its label placed clear of them. */
export function RoutedEdge({ id, markerEnd, style, data, label }: EdgeProps) {
  const appearance = data as
    | { route?: Route; workspace?: boolean; hot?: boolean; kind?: string }
    | undefined;
  const route = appearance?.route;
  if (!route) return null;
  return (
    <>
      <BaseEdge
        id={id}
        path={pathFor(route.points)}
        {...(markerEnd ? { markerEnd } : {})}
        {...(appearance?.workspace
          ? {
              className: "ui-graph-workspace-edge",
              "data-kind": appearance.kind,
              "data-hot": appearance.hot || undefined,
            }
          : style
            ? { style }
            : {})}
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
