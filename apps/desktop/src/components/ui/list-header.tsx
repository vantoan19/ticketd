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
import {
  ShellSlotContext,
  useShellLeading,
  useShellSlot,
  type ShellSlot,
} from "@/components/ui/shell-slot";
import "./patterns.css";

/** Below this header width, labelled controls collapse to their icons. */
const COLLAPSE_BELOW = 420;

const Collapsed = createContext(false);

/** Provides the shell's leading controls (shell-slot.ts) to every header below it. */
export function ShellSlotProvider({
  nav,
  crumb,
  notice,
  children,
}: ShellSlot & { children: ReactNode }) {
  return (
    <ShellSlotContext value={{ nav, crumb, notice }}>
      {children}
    </ShellSlotContext>
  );
}

/**
 * The shell's leading controls, for a header that is not a PaneHeader or
 * PageHeader (those place it themselves). `navOnly` leaves the return crumb
 * to the view's first header, as a detail pane does.
 */
export function ShellLeading({ navOnly = false }: { navOnly?: boolean }) {
  const { nav, crumb } = useShellSlot();
  if (!nav && (navOnly || !crumb)) return null;
  return (
    <>
      {nav}
      {!navOnly && crumb}
    </>
  );
}

/**
 * The 48px header of every pane: lists, detail, graph, Chats, Inbox. It never
 * wraps by default. The responsive variant reserves two rows below a 640px
 * pane, keeping the name above a dense action cluster. Its leading slot starts
 * with the shell's controls (ShellSlotProvider:
 * the narrow-nav button, the way back to the graph), then `leading`, such as
 * the pane's own `ReturnCrumb`; the title
 * (14/20/500) truncates, with `count` effectively 8px after it (6px gap plus 2px optical spacing) (a `Count`, or a summary in
 * that slot) and optional `children` as inline meta (a SegmentedControl).
 * `actions` is the right cluster of the view’s 28px controls. Ticket lists
 * have Filter and Display; use `PaneHeaderButton` for labelled ones so they
 * collapse to icons with tooltips below a 420px pane. A search field marked
 * `data-slot="pane-search"` expands in place over the title. `caption` adds
 * one fixed 28px line under the header ("Todo tickets with nothing left to
 * wait on."). `icon` is a 16px muted mark before the title (a Plan's
 * Layers); `titleEditor` takes the title's place while it is renamed in
 * place, at the same height, so nothing around it moves. `titleControl`
 * makes the title itself a control, such as the trigger of a scope menu
 * ("Chats ⌄"): it renders the heading's content.
 */
export function PaneHeader({
  title,
  titleId,
  titleLevel = 1,
  icon,
  titleEditor,
  count,
  leading,
  hideTitle = false,
  children,
  actions,
  caption,
  className,
  titleControl,
  variant = "default",
}: {
  title: string;
  /** Ticket headers supply their reference heading and shell controls in leading. */
  variant?: "default" | "ticket" | "responsive";
  /** Renders the title as a control inside the heading (a menu trigger). */
  titleControl?: (title: string) => ReactNode;
  /** The heading's id, for `aria-labelledby` and focus after a change. */
  titleId?: string;
  /** Pass null when the pane below already supplies its heading. */
  titleLevel?: 1 | 2 | null;
  icon?: ReactNode;
  titleEditor?: ReactNode;
  count?: ReactNode;
  leading?: ReactNode;
  /** Keeps the title for screen readers only, where a control in the header names the view. */
  hideTitle?: boolean;
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
  const Heading = titleLevel === null ? "span" : titleLevel === 1 ? "h1" : "h2";
  const shell = useShellLeading();
  const { notice } = useShellSlot();
  return (
    <Collapsed value={collapsed}>
      <header
        ref={header}
        data-slot="pane-header"
        data-arrive="header"
        data-title-editor={titleEditor ? "" : undefined}
        data-leading={leading || shell ? "" : undefined}
        data-collapsed={collapsed || undefined}
        className={cn(
          "ui-pane-header",
          variant === "ticket" && "detail-header",
          variant === "responsive" && "ui-pane-header-responsive",
          className,
        )}
      >
        {shell && variant !== "ticket" && <ShellLeading />}
        {leading}
        {(variant !== "ticket" ||
          icon != null ||
          count != null ||
          children != null) && (
          <span className="ui-pane-header-title">
            {icon && (
              <span aria-hidden="true" className="ui-pane-header-icon">
                {icon}
              </span>
            )}
            {variant === "ticket"
              ? null
              : (titleEditor ??
                (hideTitle ? (
                  <Heading id={titleId} className="sr-only">
                    {title}
                  </Heading>
                ) : titleControl ? (
                  <Heading
                    id={titleId}
                    tabIndex={titleId ? -1 : undefined}
                    data-control=""
                  >
                    {titleControl(title)}
                  </Heading>
                ) : (
                  // The full title while it is cut, below the header.
                  <Tooltip content={title} side="bottom" overflowOnly>
                    <Heading
                      id={titleId}
                      data-slot="pane-heading"
                      tabIndex={titleId ? -1 : undefined}
                    >
                      {title}
                    </Heading>
                  </Tooltip>
                )))}
            {count}
            {children}
          </span>
        )}
        {(actions || notice !== undefined) && (
          <span className="ui-pane-header-actions">
            <ShellNoticeSlot />
            {actions}
          </span>
        )}
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
  arrow = true,
}: {
  origin: string;
  onReturn: () => void;
  /** The accessible name, when "Back to {origin}" is not the clearest. */
  label?: string;
  /** Without the arrow, a crumb that continues the path of the one before it. */
  arrow?: boolean;
}) {
  return (
    <span data-slot="return-crumb" className="ui-return-crumb">
      <Button variant="ghost" size="sm" aria-label={label} onClick={onReturn}>
        {arrow && <ArrowLeft aria-hidden="true" />}
        <span className="ui-return-crumb-origin">{origin}</span>
      </Button>
      <span aria-hidden="true">/</span>
    </span>
  );
}

/** Kept in the header from its first frame, so failure controls cannot displace actions. */
export function ShellNoticeSlot() {
  const { notice } = useShellSlot();
  return notice === undefined ? null : (
    <span className="ui-shell-notice-slot">{notice}</span>
  );
}
