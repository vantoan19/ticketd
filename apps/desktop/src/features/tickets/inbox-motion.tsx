import { useState, type ReactNode } from "react";
import { m } from "motion/react";
import { Presence } from "@/components/ui/motion";
import { arrival } from "@/components/ui/row-motion";
import { StatusDot } from "@/components/ui/status-dot";
import { exitTransition } from "@/lib/motion-tokens";

/** The motion of Inbox entries (DESIGN.md section 12). */

/**
 * One entry's place in its group. A new entry opens its space and fades up
 * from a soft blur, so the entries below glide down with it. Entries already
 * on screen do not animate. (Nothing hides read entries, so none exits.) The
 * motion is only for an entry that mounts arriving, so it is built, and the
 * tokens read, once for that entry and for no other.
 */
export function EntrySlot({
  arriving,
  children,
}: {
  arriving: boolean;
  children: ReactNode;
}) {
  const [motion] = useState(() =>
    arriving ? arrival(0, { space: true }) : null,
  );
  return (
    <m.li
      data-arrive="row"
      {...(motion ? motion : { initial: false as const })}
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
