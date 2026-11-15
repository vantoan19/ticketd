import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import "./patterns.css";

/** Below this header width, labelled controls collapse to their icons. */
const COLLAPSE_BELOW = 420;

const Collapsed = createContext(false);

/**
 * The 48px header of every pane: lists, detail, graph, Chats, Inbox. It never
 * wraps. `leading` holds the narrow-nav button or a `ReturnCrumb`; the title
 * (14/20/500) truncates, with `count` 8px after it (a `Count`, or a summary in
 * that slot) and optional `children` as inline meta (a SegmentedControl).
 * `actions` is the right cluster of 32px controls in a fixed order: Refresh,
 * Search, Filters, Display; use `PaneHeaderButton` for labelled ones so they
 * collapse to icons with tooltips below a 420px pane. A search field marked
 * `data-slot="pane-search"` expands in place over the title. `caption` adds
 * one fixed 28px line under the header ("Todo tickets with nothing left to
 * wait on.").
 */
export function PaneHeader({
  title,
  titleId,
  titleLevel = 1,
  count,
  leading,
  children,
  actions,
  caption,
  className,
}: {
  title: string;
  /** The heading's id, for `aria-labelledby` and focus after a change. */
  titleId?: string;
  titleLevel?: 1 | 2;
  count?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  caption?: string | null;
  className?: string;
}) {
  const header = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setCollapsed(width < COLLAPSE_BELOW);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const Heading = titleLevel === 1 ? "h1" : "h2";
  return (
    <Collapsed value={collapsed}>
      <header
        ref={header}
        data-slot="pane-header"
        data-leading={leading ? "" : undefined}
        data-collapsed={collapsed || undefined}
        className={cn("ui-pane-header", className)}
      >
        {leading}
        <span className="ui-pane-header-title">
          {/* The full title while it is cut, below the header. */}
          <Tooltip content={title} side="bottom" overflowOnly>
            <Heading id={titleId} tabIndex={titleId ? -1 : undefined}>
              {title}
            </Heading>
          </Tooltip>
          {count}
          {children}
        </span>
        {actions && <span className="ui-pane-header-actions">{actions}</span>}
      </header>
      {caption && <p className="ui-pane-header-caption">{caption}</p>}
    </Collapsed>
  );
}

/**
 * A labelled header control ("Display", "Filters") that becomes an icon
 * button with its label as tooltip when the pane is narrow. `icon` is 16px.
 */
export function PaneHeaderButton({
  icon,
  label,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & {
  icon: ReactNode;
  label: string;
  /** Extra marks after the label, such as an active-filter count. */
  children?: ReactNode;
}) {
  const collapsed = use(Collapsed);
  if (collapsed)
    return (
      <IconButton label={label} {...props}>
        {icon}
        {children}
      </IconButton>
    );
  return (
    <Button variant="ghost" size="sm" {...props}>
      {icon}
      {label}
      {children}
    </Button>
  );
}

/**
 * The way back to where the person came from, in a pane header's leading
 * slot: `← {Origin} /`, the origin truncated at 18ch. It replaces "Back to …"
 * strips. ⌘[ goes back; Escape does not.
 */
export function ReturnCrumb({
  origin,
  onReturn,
  label = `Back to ${origin}`,
}: {
  origin: string;
  onReturn: () => void;
  /** The accessible name, when "Back to {origin}" is not the clearest. */
  label?: string;
}) {
  return (
    <span data-slot="return-crumb" className="ui-return-crumb">
      <Button variant="ghost" size="sm" aria-label={label} onClick={onReturn}>
        <ArrowLeft aria-hidden="true" />
        <span className="ui-return-crumb-origin">{origin}</span>
      </Button>
      <span aria-hidden="true">/</span>
    </span>
  );
}
