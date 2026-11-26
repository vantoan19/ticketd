import type { CSSProperties, ReactNode } from "react";
import "./view-bar.css";

/**
 * The floating control bar of a viewer stage (DESIGN.md section 11): 40px, the
 * popover surface, centered 16px above the stage's bottom edge. It sits last in
 * a scrolling stage and sticks to the bottom, so it never moves the content and
 * stays put while the stage scrolls. Only formats with controls get one.
 */
export function ViewBar({
  label,
  stageWidth,
  children,
}: {
  label: string;
  /**
   * The width the stage shows, for a stage that scrolls sideways (a zoomed PDF, an
   * unwrapped log): its content is wider than the stage, so the dock spans what is
   * visible instead of the content and the bar stays centered under the scroll.
   */
  stageWidth?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="view-bar-dock"
      style={
        stageWidth
          ? ({ "--stage-width": `${stageWidth}px` } as CSSProperties)
          : undefined
      }
    >
      <div role="group" aria-label={label} className="view-bar">
        {children}
      </div>
    </div>
  );
}

/** Controls that belong together; groups are set apart by space, not lines. */
export function ViewBarGroup({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={label ? "group" : undefined}
      aria-label={label}
      className="view-bar-group"
    >
      {children}
    </div>
  );
}
