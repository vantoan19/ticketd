import type { ComponentProps, ReactNode } from "react";
import { useIsPresent } from "motion/react";
import { Appear } from "@/components/ui/motion";
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
