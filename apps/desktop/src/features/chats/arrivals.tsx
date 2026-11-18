import type { ComponentProps, ReactNode } from "react";
import { m, useIsPresent } from "motion/react";
import { Appear } from "@/components/ui/motion";
import { spring } from "@/lib/motion-tokens";
import { useArrived } from "@/features/chats/use-arrivals";

/**
 * Rises 8px and fades up from a soft blur when `id` has just arrived; plain
 * otherwise. With no `className` it adds no element at all when it is not an
 * arrival.
 */
export function Arrives({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const arrived = useArrived(id);
  if (arrived)
    return (
      <Appear rise="overlay" {...(className && { className })}>
        {children}
      </Appear>
    );
  return className ? <div className={className}>{children}</div> : children;
}

/**
 * An element of the Chat that fades up from a soft blur when it mounts and out
 * when it leaves (inside `Presence`). Takes the Chat's own class names. While
 * it leaves nothing in it can be reached: it is `inert`.
 */
export function Rise(props: ComponentProps<typeof Appear>) {
  const present = useIsPresent();
  return (
    <Appear rise="overlay" {...props} {...(!present && { inert: true })} />
  );
}

/**
 * A box that closes its own height when it leaves (inside `Presence`), so what
 * sits below glides up as the words in it fade (a `Rise` inside) instead of
 * jumping when they have gone. It adds no fade of its own. Timing is read as it
 * renders, so reduced motion and a held key reach it.
 *
 * A box that comes back while it leaves returns to its own height (`auto`),
 * never staying at the height it had reached. While its height is a number of
 * pixels it is moving, and `DockSlot` follows it instead of springing after it.
 * Once it leaves it takes no pointer (`data-leaving`).
 */
export function Space({
  as = "div",
  className,
  children,
}: {
  as?: "div" | "li";
  className?: string;
  children: ReactNode;
}) {
  const Box = as === "li" ? m.li : m.div;
  const present = useIsPresent();
  return (
    <Box
      data-space=""
      {...(className && { className })}
      {...(!present && { "data-leaving": "" })}
      animate={{ height: "auto", transitionEnd: { overflow: "visible" } }}
      exit={{
        height: 0,
        overflow: "clip",
        transition: { height: spring("smooth") },
      }}
    >
      {children}
    </Box>
  );
}
