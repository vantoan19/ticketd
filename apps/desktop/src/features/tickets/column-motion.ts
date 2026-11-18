import { arrival } from "@/components/ui/row-motion";
import { staggerDelay } from "@/lib/motion-tokens";

// How the Board's columns enter (DESIGN.md section 6, Board motion).

/**
 * The columns' entrance when Board is chosen: each fades up a stagger step
 * behind the one before. The tokens are read once for all of them, because a
 * drag renders the board on every pointer move; a column reading its own
 * would cost a read of the tokens per column.
 */
export function columnArrivals(count: number) {
  const { initial, animate } = arrival(0);
  const { transition } = animate;
  const step = staggerDelay(1);
  const longest = staggerDelay(Number.POSITIVE_INFINITY);
  return Array.from({ length: count }, (_, position) => {
    const delay = Math.min(position * step, longest);
    return {
      initial,
      animate: {
        ...animate,
        transition: {
          default: { ...transition.default, delay },
          y: { ...transition.y, delay },
          height: { ...transition.height, delay },
          marginTop: { ...transition.marginTop, delay },
        },
      },
    };
  });
}
