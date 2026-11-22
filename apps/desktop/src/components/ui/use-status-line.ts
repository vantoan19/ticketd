import { createContext, use, useEffect, type ReactNode } from "react";

/** How long a plain outcome, and one that can be undone, stays readable. */
export const STATUS_LINE_TIMINGS = { plain: 4_000, undo: 10_000 } as const;

export type StatusLineAction = {
  /** "Undo", "Open", "Retry", "Copy link": a verb, never a sentence. */
  label: string;
  run: () => unknown;
};

/**
 * One transient outcome. `message` is past tense with the reference ("Moved
 * T-FV16 to Trash"). `undo` is the reversible-removal shorthand: an "Undo"
 * action and the 10s lifetime; when undoing fails the line turns into the
 * failure with Retry. `tone: "error"` stays until dismissed or retried.
 */
export type StatusLineMessage = {
  message: string;
  /** Raw diagnostics shown only in the anchored Details popover. */
  details?: string;
  tone?: "default" | "error";
  icon?: ReactNode;
  action?: StatusLineAction;
  secondaryAction?: StatusLineAction;
  undo?: () => unknown;
  /** Moves keyboard focus to the action, for a failure the person must answer. */
  focusAction?: boolean;
  /** Called when the person closes the line (its × or Escape). */
  onDismiss?: () => void;
};

export type StatusLine = {
  /** Shows a message in this pane, replacing whatever was there. */
  show: (message: StatusLineMessage) => void;
  dismiss: () => void;
};

export type StatusLineRegionValue = StatusLine & {
  /** Space kept free at the bottom of the pane (the bulk bar), in px. */
  setInset: (px: number) => void;
};

export const StatusLineContext = createContext<StatusLineRegionValue | null>(
  null,
);

const ignore: StatusLine = { show: () => undefined, dismiss: () => undefined };

/**
 * Posts transient outcomes to the status line of the pane this component
 * renders in (the nearest `StatusLineRegion`). Outside any region it does
 * nothing, so a part can be rendered alone in a test or a preview.
 *
 *     const statusLine = useStatusLine();
 *     statusLine.show({ message: "Moved T-1 to Trash", undo: () => restore() });
 */
export function useStatusLine(): StatusLine {
  return use(StatusLineContext) ?? ignore;
}

/**
 * Keeps `px` free at the bottom of the pane while mounted, so the status line
 * floats above a docked bar (the bulk bar) instead of covering it.
 */
export function useStatusLineInset(px: number) {
  const region = use(StatusLineContext);
  useEffect(() => {
    if (!region) return;
    region.setInset(px);
    return () => region.setInset(0);
  }, [region, px]);
}
