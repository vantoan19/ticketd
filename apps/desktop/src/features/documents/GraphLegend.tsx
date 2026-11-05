import { edgeDashes, edgeLabels, edgeStrokeWidth } from "./graph-text";

const legendKinds = [
  "blocks",
  "membership",
  "document",
  "subticket",
  "related",
  "discovered",
  "mention",
  "activity",
  "support",
];

/** Line samples for the relationships a graph draws; arrows point source to target. */
export function GraphLegend() {
  return (
    <ul className="graph-legend" aria-label="Legend">
      {legendKinds.map((kind) => (
        <li key={kind}>
          <svg width="28" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="22"
              y2="4"
              stroke="currentColor"
              strokeWidth={edgeStrokeWidth(kind)}
              {...(edgeDashes[kind]
                ? { strokeDasharray: edgeDashes[kind] }
                : {})}
            />
            <polygon points="22,0 28,4 22,8" fill="currentColor" />
          </svg>
          {edgeLabels[kind]}
        </li>
      ))}
    </ul>
  );
}
