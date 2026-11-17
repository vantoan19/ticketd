import type { ReactNode } from "react";
import { m } from "motion/react";
import { Presence } from "@/components/ui/motion";
import { StatusDot } from "@/components/ui/status-dot";
import {
  blur,
  enterTransition,
  exitTransition,
  rise,
  spring,
} from "@/lib/motion-tokens";

/** The motion of Inbox entries (DESIGN.md section 12). */

/**
 * One entry's place in its group. A new entry opens its space and fades up
 * from a soft blur, so the entries below glide down with it. Entries already
 * on screen do not animate. (Nothing hides read entries, so none exits.)
 */
export function EntrySlot({
  arriving,
  children,
}: {
  arriving: boolean;
  children: ReactNode;
}) {
  const smooth = spring("smooth");
  return (
    <m.li
      initial={
        arriving
          ? {
              height: 0,
              opacity: 0,
              y: rise("row"),
              filter: `blur(${blur("in")}px)`,
              overflow: "hidden",
            }
          : false
      }
      animate={{
        height: "auto",
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        transition: { default: enterTransition(), height: smooth, y: smooth },
        transitionEnd: { overflow: "visible" },
      }}
    >
      {children}
    </m.li>
  );
}

/** The unread dot: marked read, it shrinks away in the exit time. */
export function UnreadDot({ read }: { read: boolean }) {
  return (
    <Presence initial={false}>
      {!read && (
        <m.span
          key="unread"
          exit={{ opacity: 0, scale: 0.4, transition: exitTransition() }}
        >
          <StatusDot tone="unread" size={6} />
        </m.span>
      )}
    </Presence>
  );
}
