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
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { describeFailure } from "@/lib/api/describe-failure";
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
  const region = useMemo(() => ({ show, dismiss, setInset }), [show, dismiss]);
  return (
    <StatusLineContext value={region}>
      {children}
      <span ref={anchor} hidden data-slot="status-line-anchor" />
      {shown && (
        <FloatingLine
          key={shown.id}
          shown={shown}
          anchor={anchor}
          host={host}
          inset={inset}
          show={show}
          dismiss={dismiss}
        />
      )}
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

function FloatingLine({
  shown,
  anchor,
  host: hostRef,
  inset,
  show,
  dismiss,
}: {
  shown: Shown;
  anchor: React.RefObject<HTMLSpanElement | null>;
  host: React.RefObject<HTMLElement | null> | undefined;
  inset: number;
  show: (message: StatusLineMessage) => void;
  dismiss: () => void;
}) {
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
  const [box, setBox] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
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
    dismiss();
    if (!lost) return;
    // Back to what had focus, if it is still in this pane; else the pane.
    const host = hostRef?.current ?? hostOf(anchor.current);
    const target =
      returnTo.current?.isConnected && host?.contains(returnTo.current)
        ? returnTo.current
        : host?.closest<HTMLElement>("[tabindex]");
    target?.focus({ preventScroll: true });
  }, [dismiss, anchor, hostRef, shown]);

  // Remaining time survives pauses: hovering at 3s of 4s leaves 1s after.
  const remaining = useRef<number | null>(lifetime);
  useEffect(() => {
    if (paused || remaining.current === null) return;
    const started = Date.now();
    const timer = window.setTimeout(dismiss, remaining.current);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current !== null)
        remaining.current = Math.max(
          0,
          remaining.current - (Date.now() - started),
        );
    };
  }, [paused, dismiss]);

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
        ...(failure.action === "retry" && {
          action: { label: "Retry", run: action.run },
        }),
      });
    } finally {
      setRunning(false);
    }
  }

  const line = (
    <div
      ref={lineRef}
      data-slot="status-line"
      data-tone={error ? "error" : undefined}
      role={error ? "alert" : "status"}
      className="ui-status-line"
      style={
        box
          ? {
              left: box.left,
              bottom: box.bottom + 8 + inset,
              maxWidth: `min(480px, ${Math.max(0, box.width - 16)}px)`,
            }
          : { visibility: "hidden" }
      }
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
      onKeyDown={(event) => {
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
    </div>
  );
  return createPortal(line, document.body);
}
