import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { m, useIsPresent } from "motion/react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Appear, Presence } from "@/components/ui/motion";
import { StatusDot } from "@/components/ui/status-dot";
import { FailureDetails } from "@/components/ui/failure-alert";
import { describeFailure } from "@/lib/api/describe-failure";
import { enterTransition, exitTransition } from "@/lib/motion-tokens";
import {
  STATUS_LINE_TIMINGS,
  StatusLineContext,
  type StatusLineAction,
  type StatusLineMessage,
} from "@/components/ui/use-status-line";
import "./patterns.css";

type Shown = StatusLineMessage & { id: number };

/**
 * The pane's status line: the one transient surface (DESIGN.md section 12).
 * Wrap a pane's content in a region; the line floats 8px above the bottom
 * edge of the region's parent element, centred, 40px tall, at most 480px
 * wide. One message at a time, the newest replaces the last; 4s, 10s with
 * Undo, failures until dismissed; hover or focus pauses the clock.
 */
export function StatusLineRegion({
  children,
  host,
}: {
  children: ReactNode;
  /** The pane element, when it is not the region's parent (the region wraps it). */
  host?: React.RefObject<HTMLElement | null>;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [inset, setInset] = useState(0);
  const counter = useRef(0);
  const anchor = useRef<HTMLSpanElement>(null);
  const show = useCallback((message: StatusLineMessage) => {
    counter.current += 1;
    setShown({ ...message, id: counter.current });
  }, []);
  const dismiss = useCallback(() => setShown(null), []);
  // A line closes only itself: an action that posts its own outcome (Retry
  // that succeeds with "… · Undo") must not be closed by the line it replaced.
  const dismissLine = useCallback(
    (id: number) =>
      setShown((current) => (current?.id === id ? null : current)),
    [],
  );
  const region = useMemo(() => ({ show, dismiss, setInset }), [show, dismiss]);
  return (
    <StatusLineContext value={region}>
      {children}
      <span ref={anchor} hidden data-slot="status-line-anchor" />
      <Presence>
        {shown && (
          <LineSlot
            key="slot"
            shown={shown}
            anchor={anchor}
            host={host}
            inset={inset}
            show={show}
            dismiss={dismissLine}
          />
        )}
      </Presence>
    </StatusLineContext>
  );
}

/** The element the line centres on: the region's parent element. */
function hostOf(anchor: HTMLElement | null): HTMLElement | null {
  let host = anchor?.parentElement ?? null;
  // A `display: contents` wrapper has no box of its own.
  while (host && getComputedStyle(host).display === "contents")
    host = host.parentElement;
  return host;
}

type LineProps = {
  shown: Shown;
  anchor: React.RefObject<HTMLSpanElement | null>;
  host: React.RefObject<HTMLElement | null> | undefined;
  show: (message: StatusLineMessage) => void;
  dismiss: (id: number) => void;
};

/**
 * Where the line sits, and how it comes and goes. The slot stays while the
 * line is open: it rises from a soft blur and leaves in 150ms. A following
 * outcome swaps the words inside it (they crossfade) rather than stacking a
 * second line. While it leaves it cannot be pressed.
 */
function LineSlot({ inset, ...props }: LineProps & { inset: number }) {
  const { shown, anchor, host: hostRef } = props;
  const present = useIsPresent();
  const [box, setBox] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  useLayoutEffect(() => {
    const host = hostRef?.current ?? hostOf(anchor.current);
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setBox({
        left: rect.left + rect.width / 2,
        bottom: window.innerHeight - rect.bottom,
        width: rect.width,
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor, hostRef]);
  return createPortal(
    <div
      className="ui-status-line-slot"
      inert={!present}
      style={
        box
          ? {
              left: box.left,
              bottom: box.bottom + 8 + inset,
              maxWidth: `min(480px, ${Math.max(0, box.width - 16)}px)`,
            }
          : { visibility: "hidden" }
      }
    >
      <Appear rise="overlay" className="ui-status-line">
        <Presence initial={false}>
          <FloatingLine key={shown.id} {...props} />
        </Presence>
      </Appear>
    </div>,
    document.body,
  );
}

function FloatingLine({
  shown,
  anchor,
  host: hostRef,
  show,
  dismiss,
}: LineProps) {
  const { id } = shown;
  const present = useIsPresent();
  const dismissSelf = useCallback(() => dismiss(id), [dismiss, id]);
  const error = shown.tone === "error";
  const action: StatusLineAction | undefined = shown.undo
    ? { label: "Undo", run: shown.undo }
    : shown.action;
  const lifetime = error
    ? null
    : shown.undo || action?.label === "Undo"
      ? STATUS_LINE_TIMINGS.undo
      : STATUS_LINE_TIMINGS.plain;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [running, setRunning] = useState(false);
  const paused = hovered || focused || running;
  const actionRef = useRef<HTMLButtonElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  // Where focus goes when the person closes the line from inside it.
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body)
      returnTo.current = active;
  }, []);
  /** Dismisses, keeping keyboard focus in the pane rather than on the page. */
  const close = useCallback(() => {
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      Boolean(lineRef.current?.contains(active));
    shown.onDismiss?.();
    dismissSelf();
    if (!lost) return;
    // Back to what had focus, if it is still in this pane; else the pane.
    const host = hostRef?.current ?? hostOf(anchor.current);
    const target =
      returnTo.current?.isConnected && host?.contains(returnTo.current)
        ? returnTo.current
        : host?.closest<HTMLElement>("[tabindex]");
    target?.focus({ preventScroll: true });
  }, [dismissSelf, anchor, hostRef, shown]);

  // Remaining time survives pauses: hovering at 3s of 4s leaves 1s after.
  const remaining = useRef<number | null>(lifetime);
  useEffect(() => {
    if (paused || remaining.current === null) return;
    const started = Date.now();
    const timer = window.setTimeout(dismissSelf, remaining.current);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current !== null)
        remaining.current = Math.max(
          0,
          remaining.current - (Date.now() - started),
        );
    };
  }, [paused, dismissSelf]);

  // A failure that needs an answer takes focus: its action, else Dismiss.
  useEffect(() => {
    if (!shown.focusAction) return;
    (
      actionRef.current ??
      lineRef.current?.querySelector<HTMLButtonElement>("button")
    )?.focus();
  }, [shown.focusAction]);

  async function act() {
    if (!action) return;
    setRunning(true);
    try {
      await action.run();
      close();
    } catch (reason) {
      // Plain words (P8): "Couldn't undo. The workspace is read-only, so
      // nothing changed." Retry only when retrying can succeed.
      const failure = describeFailure(reason, action.label.toLowerCase());
      show({
        tone: "error",
        message: `${failure.title}. ${failure.sentence}`,
        details: failure.details,
        ...(failure.action === "retry" && {
          action: { label: "Retry", run: action.run },
        }),
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <m.div
      ref={lineRef}
      data-slot="status-line"
      data-tone={error ? "error" : undefined}
      role={error ? "alert" : "status"}
      className="ui-status-line-body"
      inert={!present}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: enterTransition() }}
      exit={{ opacity: 0, transition: exitTransition() }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
      onKeyDown={(event) => {
        // A portaled Details popover owns its keys, even though React bubbles
        // them through this line. Only keys from the line itself dismiss it.
        if (
          event.defaultPrevented ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      {(shown.icon || error) && (
        <span aria-hidden="true" className="ui-status-line-icon">
          {shown.icon ?? <StatusDot tone="attention" size={10} />}
        </span>
      )}
      <span className="ui-status-line-message">{shown.message}</span>
      {shown.details && (
        <FailureDetails details={shown.details} variant="popover" />
      )}
      {action && (
        <Button
          ref={actionRef}
          variant="ghost"
          size="sm"
          disabled={running}
          onClick={() => void act()}
        >
          {action.label}
        </Button>
      )}
      <IconButton label="Dismiss" onClick={close}>
        <X />
      </IconButton>
    </m.div>
  );
}
