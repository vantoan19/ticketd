import { useLayoutEffect, useRef, type ReactNode } from "react";
import { m, useIsPresent } from "motion/react";
import { Presence } from "@/components/ui/motion";
import { stateTransition } from "@/lib/motion-tokens";
import { scrollParent } from "./detail-scroll";

function Layer({
  transition,
  children,
}: {
  transition: ReturnType<typeof stateTransition>;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <m.div
      className="ticket-decision-layer"
      data-leaving={!present || undefined}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition}
    >
      {children}
    </m.div>
  );
}

export function DecisionCardContent({
  state,
  children,
}: {
  state: string;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const sizing = useRef<HTMLDivElement>(null);
  const transition = stateTransition();
  useLayoutEffect(() => {
    const box = outer.current;
    const content = sizing.current;
    if (!box || !content || typeof ResizeObserver === "undefined") return;
    const syncHeight = () => {
      const height = content.getBoundingClientRect().height;
      if (height) box.style.height = `${height}px`;
    };
    const size = new ResizeObserver(syncHeight);
    syncHeight();
    size.observe(content);
    // WebKit hosts without native scroll anchoring need to follow changes
    // to the height when the entire card has scrolled above the reading area.
    const scroller = scrollParent(box);
    const anchor =
      scroller && !globalThis.CSS?.supports("overflow-anchor", "auto")
        ? observeCardHeight(box, scroller)
        : null;
    return () => {
      size.disconnect();
      anchor?.disconnect();
      box.style.removeProperty("height");
    };
  }, []);
  return (
    <div className="ticket-decision-content" ref={outer}>
      <div className="ticket-decision-measure" ref={sizing}>
        {transition.duration === 0 ? (
          <div className="ticket-decision-layer">{children}</div>
        ) : (
          <Presence initial={false}>
            <Layer key={state} transition={transition}>
              {children}
            </Layer>
          </Presence>
        )}
      </div>
    </div>
  );
}

function observeCardHeight(box: HTMLElement, scroller: HTMLElement) {
  let height = box.getBoundingClientRect().height;
  const observe = new ResizeObserver(() => {
    const rect = box.getBoundingClientRect();
    const previousHeight = height;
    height = rect.height;
    if (rect.top + previousHeight <= scroller.getBoundingClientRect().top)
      scroller.scrollTop += height - previousHeight;
  });
  observe.observe(box);
  return observe;
}
