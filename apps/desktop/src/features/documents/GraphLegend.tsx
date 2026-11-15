import { FileText, Layers, Ticket } from "lucide-react";
import { edgeLineLabels, edgeStyles } from "./graph-text";

/**
 * One sample per line style present in the graph, named with the same words as
 * the lines: the label and the line pattern carry the meaning, never colour.
 * Only "blocks" has an arrowhead, as on the canvas. Nothing shows without lines.
 */
export function GraphLegend({ labels }: { labels: string[] }) {
  const present = new Set(labels);
  const rows = edgeStyles.flatMap((style) => {
    const names = style.kinds
      .map((kind) => edgeLineLabels[kind] ?? kind)
      .filter((name) => present.has(name));
    if (names.length === 0) return [];
    const blocks = style.kinds.includes("blocks");
    return [{ style, blocks, name: blocks ? style.name : names.join(", ") }];
  });
  if (rows.length === 0) return null;
  return (
    <div className="graph-legend">
      <span className="graph-legend-title" aria-hidden="true">
        Legend
      </span>
      <ul aria-label="Legend">
        {rows.map(({ style, blocks, name }) => (
          <li key={style.name}>
            <svg width="28" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2={blocks ? 22 : 28}
                y2="4"
                stroke="currentColor"
                strokeWidth={style.width}
                {...(style.dash ? { strokeDasharray: style.dash } : {})}
              />
              {blocks && (
                <polygon points="22,0 28,4 22,8" fill="currentColor" />
              )}
            </svg>
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Small kind glyph for list rows; decorative, the row text already names the item. */
export function KindIcon({ kind }: { kind: string }) {
  const Icon =
    kind === "plan" ? Layers : kind === "document" ? FileText : Ticket;
  return <Icon aria-hidden="true" className="context-graph-kind" />;
}
