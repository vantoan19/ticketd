import type { ComponentProps, ReactNode, Ref } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { IconButton } from "@/components/ui/icon-button";
import { Reference } from "@/components/ui/reference";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { GRAPH_ZOOM } from "./graph-zoom";
import "./graph-kit.css";

/**
 * The graph kit (DESIGN.md section 10): one canvas, legend, zoom control, node
 * card, selection panel and row for every graph (a ticket's dependencies, a
 * Plan's dependencies, the workspace and context graphs). Features own their
 * data and layout; the look lives here, under `ui-graph-`.
 */

/** A line sample or a status mark in the legend. */
export type LegendMark =
  "blocks" | "line" | "dashed" | "dotted" | "ready" | "blocked" | "outside";

function LegendSample({ mark }: { mark: LegendMark }) {
  if (mark === "ready" || mark === "blocked") return <StatusDot tone={mark} />;
  if (mark === "outside")
    return <span aria-hidden="true" className="ui-graph-legend-outside" />;
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="8"
      viewBox="0 0 18 8"
      data-mark={mark}
    >
      <path d={mark === "blocks" ? "M0 4H11" : "M0 4H18"} />
      {mark === "blocks" && <polygon points="10,0 18,4 10,8" />}
    </svg>
  );
}

/**
 * One row inside the canvas, top-right, naming only what the graph shows, in
 * the words the lines use. Nothing renders without items.
 */
export function GraphLegend({
  items,
}: {
  items: { mark: LegendMark; label: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <ul className="ui-graph-legend" aria-label="Legend">
      {items.map((item) => (
        <li key={`${item.mark}:${item.label}`}>
          <LegendSample mark={item.mark} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Zoom out, the percentage (click for 100%), zoom in and Fit, bottom-left
 * inside the canvas. Buttons disable at the limits; the readout is not a live
 * region. `notInView` says how many cards are outside or cut by the edge.
 */
export function ZoomControls({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
  notInView = 0,
  min = GRAPH_ZOOM.min,
  max = GRAPH_ZOOM.max,
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  onFit: () => void;
  notInView?: number;
  min?: number;
  max?: number;
}) {
  const percent = Math.round(zoom * 100);
  return (
    <div className="ui-graph-zoom" role="group" aria-label="Zoom">
      <IconButton
        label="Zoom out"
        tooltipSide="top"
        disabled={zoom <= min + 0.001}
        onClick={onZoomOut}
      >
        <Minus />
      </IconButton>
      <Tooltip content="Zoom to 100%" side="top">
        <button
          type="button"
          className="ui-graph-zoom-percent"
          aria-label={`Zoom ${percent}%, zoom to 100%`}
          onClick={onReset}
        >
          {percent}%
        </button>
      </Tooltip>
      <IconButton
        label="Zoom in"
        tooltipSide="top"
        disabled={zoom >= max - 0.001}
        onClick={onZoomIn}
      >
        <Plus />
      </IconButton>
      <IconButton label="Fit to view" tooltipSide="top" onClick={onFit}>
        <Maximize />
      </IconButton>
      {notInView > 0 && (
        <span className="ui-graph-zoom-note">{notInView} not in view</span>
      )}
    </div>
  );
}

/**
 * The canvas frame: the surface with neutral dots, the graph filling it, the
 * legend top-right, the zoom control bottom-left and `notice` (an empty or
 * limited state, an EmptyState with `anchor="center"`) centred over it.
 */
export function GraphCanvas({
  label,
  children,
  legend,
  zoom,
  notice,
  footnote,
  className,
  ...props
}: Omit<ComponentProps<"section">, "children"> & {
  label: string;
  children?: ReactNode;
  legend?: ReactNode;
  zoom?: ReactNode;
  notice?: ReactNode;
  /** One caption at the canvas foot, beside the zoom control ("Showing 7 of 30"). */
  footnote?: ReactNode;
}) {
  return (
    <section
      data-slot="graph-canvas"
      aria-label={label}
      className={cn("ui-graph-canvas", className)}
      {...props}
    >
      {children}
      {notice && <div className="ui-graph-notice">{notice}</div>}
      {legend}
      {(zoom || footnote) && (
        <div className="ui-graph-foot">
          {zoom}
          {footnote && <p className="ui-graph-footnote">{footnote}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * A 224×64 node card. Line 1 (icon, Reference, meta, trailing mark) never
 * wraps; only the meta and the title truncate. Hover is `--hover`, selected the
 * accent fill with a 1px interactive ring, an item outside the scope is dashed.
 */
export function GraphNodeCard({
  icon,
  reference,
  meta,
  trailing,
  title,
  variant,
  reason,
  selected = false,
  outside = false,
  className,
  ref,
  ...props
}: Omit<ComponentProps<"button">, "title"> & {
  icon: ReactNode;
  reference?: string | null | undefined;
  meta?: string;
  trailing?: ReactNode;
  title: string;
  variant?: "flow";
  reason?: string;
  selected?: boolean;
  outside?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      // The visible parts are separate spans; name them as one phrase.
      aria-label={
        [reference, title].filter(Boolean).join(" ") + (meta ? `, ${meta}` : "")
      }
      data-variant={variant}
      data-slot="graph-node"
      data-selected={selected || undefined}
      data-outside={outside || undefined}
      className={cn("ui-graph-node", className)}
      {...props}
    >
      <span className="ui-graph-node-line">
        <span className="ui-graph-node-icon">{icon}</span>
        {reference && <Reference>{reference}</Reference>}
        {meta && <span className="ui-graph-node-meta">{meta}</span>}
        {trailing && <span className="ui-graph-node-trailing">{trailing}</span>}
      </span>
      <span className="ui-graph-node-title">{title}</span>
      {reason && <span className="ui-graph-node-reason">{reason}</span>}
    </button>
  );
}

/** "● Ready" or "● Blocked" for a ticket; nothing for any other availability. */
export function AvailabilityMark({
  availability,
  children,
}: {
  availability: string | null | undefined;
  /** Replaces the word ("Blocked by T-FV1"). */
  children?: ReactNode;
}) {
  if (availability !== "Ready" && availability !== "Blocked") return null;
  return (
    <span data-slot="availability" className="ui-graph-availability">
      <StatusDot tone={availability === "Ready" ? "ready" : "blocked"} />
      {children ?? availability}
    </span>
  );
}

/**
 * The fixed 280px selection panel at the canvas's right edge. The body scrolls;
 * `footer` (Open, then Center here) stays pinned at the bottom.
 */
export function GraphPanel({
  label,
  children,
  footer,
  className,
}: {
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <aside
      data-slot="graph-panel"
      aria-label={label}
      className={cn("ui-graph-panel", className)}
    >
      <div className="ui-graph-panel-body">{children}</div>
      {footer && <div className="ui-graph-panel-footer">{footer}</div>}
    </aside>
  );
}

/** The selected item: a 12px line with its icon and Reference or kind, the title, a state caption. */
export function GraphPanelHead({
  icon,
  eyebrow,
  title,
  caption,
  headingRef,
}: {
  icon: ReactNode;
  eyebrow: ReactNode;
  title: string;
  caption?: string;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="ui-graph-panel-head">
      <span className="ui-graph-panel-eyebrow">
        {icon}
        {eyebrow}
      </span>
      <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
        {title}
      </h2>
      {caption && <p className="ui-graph-panel-caption">{caption}</p>}
    </div>
  );
}

/** A titled group in the panel ("Blocked by 2") with its rows. */
export function GraphPanelSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="ui-graph-panel-section" aria-label={title}>
      <h3>
        {title} {count !== undefined && <Count>{count}</Count>}
      </h3>
      {children}
    </section>
  );
}

/**
 * A row naming one item, in the panel and in graph lists: `[icon][Reference]
 * [caption]` on line 1, the title on line 2 (two lines at most). The whole row
 * is the button; the current one takes the accent fill and `aria-current`.
 */
export function GraphRow({
  icon,
  reference,
  caption,
  title,
  current = false,
  onClick,
  label,
  trailing,
}: {
  icon: ReactNode;
  reference?: string | null | undefined;
  caption?: string;
  title: string;
  current?: boolean;
  onClick: () => void;
  /** The accessible name, when the visible words are not the clearest. */
  label?: string;
  /** A hover action after the row (an IconButton); it is not part of the row's button. */
  trailing?: ReactNode;
}) {
  return (
    <div className="ui-graph-row" data-current={current || undefined}>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        // The visible parts are separate spans; name them as one phrase.
        aria-label={
          label ??
          [reference, title].filter(Boolean).join(" ") +
            (caption ? `, ${caption}` : "")
        }
        onClick={onClick}
      >
        <span className="ui-graph-row-icon">{icon}</span>
        {reference ? (
          <Reference>{reference}</Reference>
        ) : (
          <span className="ui-graph-row-title" data-inline="">
            {title}
          </span>
        )}
        {caption && <span className="ui-graph-row-caption">{caption}</span>}
        {reference && <span className="ui-graph-row-title">{title}</span>}
      </button>
      {trailing && <span className="ui-graph-row-trailing">{trailing}</span>}
    </div>
  );
}

/** Open the selected item (primary) and centre the graph on it (ghost). */
export function GraphPanelActions({
  openLabel,
  onOpen,
  centerLabel = "Center here",
  onCenter,
}: {
  openLabel: string;
  onOpen?: () => void;
  centerLabel?: string;
  /** Left out when the item is already the centre. */
  onCenter?: () => void;
}) {
  return (
    <>
      {onOpen && (
        <Button size="sm" onClick={onOpen}>
          {openLabel}
        </Button>
      )}
      {onCenter && (
        <Button variant="ghost" size="sm" onClick={onCenter}>
          {centerLabel}
        </Button>
      )}
    </>
  );
}

/** Flow uses the graph cards in three readable wells, without graph pan or zoom. */
export function GraphFlowLane({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section className="ui-graph-flow-lane" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <span>{caption}</span>
      </header>
      {children}
    </section>
  );
}
