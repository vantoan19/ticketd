import { useLayoutEffect, useRef, type ReactNode } from "react";
import { spring } from "@/lib/motion-tokens";

/**
 * A part of the dock whose height glides to its content's instead of cutting,
 * so a card arriving or leaving slides the transcript rather than jerking it.
 * The transcript follows the scroller's size frame by frame, so a reader at the
 * end stays at the end through the glide. The content shows clipped only while
 * it glides; at rest it may overflow (the activity drawer tucks under the
 * composer).
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
