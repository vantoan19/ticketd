import { useLayoutEffect, useRef, type ReactNode } from "react";
import { spring } from "@/lib/motion-tokens";

/** Whether a `Space` inside `element` is moving its height (a pixel one, not `auto`). */
function spaceMoving(element: HTMLElement): boolean {
  return [...element.querySelectorAll<HTMLElement>("[data-space]")].some(
    (space) => space.style.height.endsWith("px"),
  );
}

/**
 * A part of the dock whose height glides to its content's instead of cutting,
 * so a card arriving or leaving slides the transcript rather than jerking it.
 * The transcript follows the scroller's size frame by frame, so a reader at the
 * end stays at the end through the glide. The content shows clipped only while
 * it glides; at rest it may overflow (the activity drawer tucks under the
 * composer). A change that is not itself an animation (a card arriving) glides
 * on the spring; one a `Space` inside is animating is followed as it goes.
 */
export function DockSlot({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = outer.current;
    const content = inner.current;
    if (!slot || !content || typeof ResizeObserver === "undefined") return;
    let height = content.offsetHeight;
    slot.style.height = `${height}px`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight;
      if (next === height) return;
      height = next;
      slot.dataset.gliding = "";
      // A box inside moves its own height (Space): the slot is its height
      // frame by frame. A glide begun anew every frame would never get going.
      if (spaceMoving(content)) slot.dataset.following = "";
      else delete slot.dataset.following;
      slot.style.height = `${next}px`;
      clearTimeout(timer);
      // The glide is the smooth spring (`.chat-dock-slot`); reduced motion and a
      // held key make it zero.
      timer = setTimeout(
        () => delete slot.dataset.gliding,
        spring("smooth").duration * 1000 + 50,
      );
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);
  return (
    <div ref={outer} className={`chat-dock-slot ${className}`.trim()}>
      <div ref={inner} className="chat-dock-slot-content">
        {children}
      </div>
    </div>
  );
}
