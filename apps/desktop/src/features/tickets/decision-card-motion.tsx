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
    const card = box.parentElement;
    const scroller = scrollParent(box);
    let adjustScroll: (() => void) | undefined;
    let resizeFrame = 0;
    const finishResize = () => {
      adjustScroll = undefined;
      delete box.dataset.resizing;
    };
    const syncHeight = () => {
      const height = content.getBoundingClientRect().height;
      const nextHeight = `${height}px`;
      if (!height || box.style.height === nextHeight) return;
      if (!box.style.height || !card || !scroller) {
        box.style.height = nextHeight;
        return;
      }

      // Anchor these frames ourselves. WebKit can report CSS support without
      // compensating, and native anchoring would double the shift when it works.
      box.dataset.resizing = "true";
      adjustScroll ??= followCardHeight(card, scroller);
      box.style.height = nextHeight;
      const animation = box.getAnimations?.()[0];
      const frame = () => {
        adjustScroll?.();
        if (animation?.playState === "running")
          resizeFrame = requestAnimationFrame(frame);
        else finishResize();
      };
      cancelAnimationFrame(resizeFrame);
      frame();
    };
    const size = new ResizeObserver(syncHeight);
    syncHeight();
    size.observe(content);
    return () => {
      size.disconnect();
      cancelAnimationFrame(resizeFrame);
      finishResize();
      box.style.removeProperty("height");
    };
  }, []);
  return (
    <div className="ticket-decision-content" ref={outer}>
      <div className="ticket-decision-measure" ref={sizing}>
        {/* Keep the focused control mounted when the input guard's duration
            changes between instant and animated motion. */}
        <Presence initial={false}>
          <Layer key={state} transition={transition}>
            {children}
          </Layer>
        </Presence>
      </div>
    </div>
  );
}

function followCardHeight(card: HTMLElement, scroller: HTMLElement) {
  const page = card.closest<HTMLElement>(".detail-content");
  let height = card.getBoundingClientRect().height;
  let scrollTop = scroller.scrollTop;
  let remainder = 0;
  return () => {
    if (page?.hidden || page?.hasAttribute("data-leaving")) return;
    const rect = card.getBoundingClientRect();
    const change = rect.height - height;
    height = rect.height;
    const top = scroller.scrollTop;
    const wasAbove =
      rect.bottom - change <= scroller.getBoundingClientRect().top;
    if (!height || !wasAbove) {
      remainder = 0;
    } else if (change) {
      // Shrinking can clamp the offset at the end before this frame runs.
      const atEnd = top + scroller.clientHeight >= scroller.scrollHeight;
      const beforeClamp = change < 0 && atEnd ? Math.max(top, scrollTop) : top;
      const expected = beforeClamp + change + remainder;
      scroller.scrollTop = expected;
      // Some webviews round scrollTop to whole pixels on each frame.
      remainder = expected - scroller.scrollTop;
      if (Math.abs(remainder) >= 1) remainder = 0;
    }
    scrollTop = scroller.scrollTop;
  };
}
