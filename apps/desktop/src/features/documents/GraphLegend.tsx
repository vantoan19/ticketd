import { FileText, Layers, Ticket } from "lucide-react";
import { edgeStyles } from "./graph-text";

/** One sample per line style, naming the relationships it stands for; arrows point source to target. */
export function GraphLegend() {
  return (
    <ul className="graph-legend" aria-label="Legend">
      {edgeStyles.map((style) => (
        <li key={style.name}>
          <svg width="28" height="8" aria-hidden="true" color={style.color}>
            <line
              x1="0"
              y1="4"
              x2="22"
              y2="4"
              stroke="currentColor"
              strokeWidth={style.width}
              {...(style.dash ? { strokeDasharray: style.dash } : {})}
            />
            <polygon points="22,0 28,4 22,8" fill="currentColor" />
          </svg>
          {style.name}
        </li>
      ))}
    </ul>
  );
}

/** Small kind glyph for list rows; decorative, the row text already names the item. */
export function KindIcon({ kind }: { kind: string }) {
  const Icon =
    kind === "plan" ? Layers : kind === "document" ? FileText : Ticket;
  return <Icon aria-hidden="true" className="context-graph-kind" />;
}
