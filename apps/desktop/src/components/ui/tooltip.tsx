import * as React from "react";
import { cn } from "cn";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { Kbd } from "@/components/ui/kbd";

type Side = "top" | "right" | "bottom" | "left";

// DESIGN.md section 4, tooltip row: one provider for the app, so moving along a
// toolbar shows the next label at once instead of waiting again.
const DELAY_MS = 400;
const SKIP_DELAY_MS = 300;

const ProviderMounted = React.createContext(false);
const DefaultSide = React.createContext<Side>("top");

/**
 * The app-level tooltip provider: 400ms before the first label, then 300ms in
 * which the next one opens without waiting. Mount it once at the root. A
 * Tooltip rendered outside it (a test, a detached portal) brings its own.
 */
function TooltipProvider({
  delayDuration = DELAY_MS,
  skipDelayDuration = SKIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <ProviderMounted value={true}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        skipDelayDuration={skipDelayDuration}
        {...props}
      />
    </ProviderMounted>
  );
}

/**
 * Sets the side tooltips open on inside a region: `right` for the sidebar and
 * the rail, `bottom` for pane headers and toolbars. Outside any region,
 * inline items open on `top`.
 */
function TooltipSide({
  side,
  children,
}: {
  side: Side;
  children: React.ReactNode;
}) {
  return <DefaultSide value={side}>{children}</DefaultSide>;
}

// Focus opens a tooltip only when the person moved it there with the keyboard.
// Focus that a closing menu or dialog returns to its opener (after Escape,
// Enter or a click) must not show the label over the screen it came back to.
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);
const NAVIGATION_WINDOW_MS = 100;
let lastNavigation = -Infinity;
let tracking = false;

function trackNavigationKeys() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener(
    "keydown",
    (event) => {
      lastNavigation = NAVIGATION_KEYS.has(event.key)
        ? performance.now()
        : -Infinity;
    },
    true,
  );
}

function focusFromNavigation() {
  return performance.now() - lastNavigation < NAVIGATION_WINDOW_MS;
}

// A label must not open, or outlive the moment, a menu, select or dialog is
// layered over its trigger. A tooltip inside that overlay is unaffected.
const OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function coveredByOverlay(trigger: Element | null) {
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll(OVERLAY)).some(
    (overlay) => !trigger || !overlay.contains(trigger),
  );
}

/**
 * A short label for the control it wraps (DESIGN.md section 4, P4). It opens
 * on hover after the provider's delay and on keyboard focus, never on focus
 * that returns after a menu or dialog closes. With no `content` nothing is
 * rendered but the child, so a hidden tooltip can never catch Escape.
 *
 * - `content`: the label; for icon-only controls use IconButton, which also
 *   names the button. Never the only place an explanation lives.
 * - `shortcut`: keys shown as Kbd chips after the label ("New ticket  C").
 * - `side`: overrides the region's side (see TooltipSide).
 * - `overflowOnly`: for a truncated name whose full text is the content. The
 *   label shows only while the child's text is actually cut (P4), so a name
 *   that fits never repeats itself. The child clips its own text.
 *
 * The child must take a ref and DOM props (a button, link, or a `<time
 * tabIndex={0}>`); non-focusable children get the label on hover only.
 */
function Tooltip({
  content,
  shortcut,
  side,
  align = "center",
  children,
  disabled = false,
  overflowOnly = false,
}: {
  content: React.ReactNode;
  shortcut?: string | string[];
  side?: Side;
  align?: "start" | "center" | "end";
  children: React.ReactElement;
  /** Keeps the label closed (for example while the control is being dragged). */
  disabled?: boolean;
  overflowOnly?: boolean;
}) {
  const regionSide = React.useContext(DefaultSide);
  const hasProvider = React.useContext(ProviderMounted);
  const [open, setOpen] = React.useState(false);
  const [cut, setCut] = React.useState(false);
  const measure = (node: HTMLElement) => {
    if (overflowOnly)
      setCut(
        node.scrollWidth > node.clientWidth ||
          node.scrollHeight > node.clientHeight,
      );
  };
  const trigger = React.useRef<HTMLElement | null>(null);
  React.useEffect(trackNavigationKeys, []);
  React.useEffect(() => {
    if (!open) return;
    const observer = new MutationObserver(() => {
      if (coveredByOverlay(trigger.current)) setOpen(false);
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [open]);

  const empty =
    content === null ||
    content === undefined ||
    content === false ||
    content === "";
  if (empty) return children;

  const keys =
    shortcut === undefined
      ? []
      : Array.isArray(shortcut)
        ? shortcut
        : [shortcut];
  const root = (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={open && !disabled && (!overflowOnly || cut)}
      onOpenChange={(next) => {
        if (next && coveredByOverlay(trigger.current)) return;
        setOpen(next);
      }}
    >
      <TooltipPrimitive.Trigger
        asChild
        // Radix composes this with the child's own ref.
        ref={(node) => {
          trigger.current = node;
        }}
        onPointerEnter={(event) => measure(event.currentTarget)}
        onFocus={(event) => {
          measure(event.currentTarget);
          // Radix skips its own open when the event is default-prevented.
          if (!focusFromNavigation()) event.preventDefault();
        }}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipContent side={side ?? regionSide} align={align}>
        {content}
        {keys.map((key) => (
          <Kbd key={key} variant="inverted">
            {key}
          </Kbd>
        ))}
      </TooltipContent>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? root : <TooltipProvider>{root}</TooltipProvider>;
}

/**
 * The chip itself: `--tooltip` on `--tooltip-foreground`, 12/16 text, 4px 8px
 * padding, at most 240px wide and wrapping, no arrow. Internal: Tooltip places
 * it.
 */
function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "ui-tooltip z-50 flex w-fit max-w-60 items-center gap-2 origin-(--radix-tooltip-content-transform-origin)",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipProvider, TooltipSide };
