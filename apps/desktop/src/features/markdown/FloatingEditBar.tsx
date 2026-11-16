import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

type EditBars = {
  active: HTMLElement | null;
  bars: Map<HTMLElement, (active: boolean) => void>;
};
const paneBars = new WeakMap<Element, EditBars>();
function activate(bars: EditBars, owner: HTMLElement) {
  bars.active = owner;
  for (const [anchor, show] of bars.bars) show(anchor === owner);
}

/** Editing controls float inside the visible pane, outside its scrolling prose. */
export function FloatingEditBar({
  status,
  controlsRef,
  onDone,
  feedback,
  actions,
}: {
  status: ReactNode;
  controlsRef: (element: HTMLSpanElement | null) => void;
  onDone?: () => void;
  feedback?: ReactNode;
  actions?: ReactNode;
}) {
  const [pane, setPane] = useState<Element | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(true);
  useLayoutEffect(() => {
    const owner = anchor.current;
    if (!pane || !owner) return;
    let bars = paneBars.get(pane);
    if (!bars) {
      bars = { active: null, bars: new Map() };
      paneBars.set(pane, bars);
    }
    const registry = bars;
    registry.bars.set(owner, setActive);
    activate(registry, owner);
    const focus = (event: Event) => {
      if (
        event.target instanceof Node &&
        owner.parentElement?.contains(event.target)
      )
        activate(registry, owner);
    };
    pane.addEventListener("focusin", focus);
    return () => {
      pane.removeEventListener("focusin", focus);
      registry.bars.delete(owner);
      if (registry.active === owner) {
        const previous = [...registry.bars.keys()].at(-1);
        if (previous) activate(registry, previous);
        else paneBars.delete(pane);
      }
    };
  }, [pane]);
  return (
    <>
      <span
        hidden
        ref={(element) => {
          anchor.current = element;
          if (element)
            setPane(
              element.closest(
                ".ticket-detail, .document-workspace, .context-view-wrapper",
              ) ?? element.parentElement,
            );
        }}
      />
      {pane &&
        createPortal(
          <div
            className="floating-edit-position"
            hidden={!active && !feedback}
            data-inactive={!active || undefined}
          >
            {feedback && (
              <div className="floating-edit-feedback">{feedback}</div>
            )}
            <div
              role="group"
              aria-label="Edit controls"
              className="floating-edit-bar"
              hidden={!active}
            >
              <span className="floating-edit-status">{status}</span>
              <span ref={controlsRef} className="floating-edit-tools" />
              {actions}
              {onDone && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Done editing"
                  onClick={onDone}
                >
                  Done <Kbd aria-hidden="true">esc</Kbd>
                </Button>
              )}
            </div>
          </div>,
          pane,
        )}
    </>
  );
}
