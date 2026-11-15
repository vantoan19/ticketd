import { cn } from "cn";
import "./patterns.css";

/**
 * A still placeholder in the final geometry of what is loading. It appears
 * only after 300ms, so a fast read never flashes it; size it with layout
 * classes (`h-3 w-24`). Announce loading once around a group of skeletons.
 */
function Skeleton({
  className,
  shape = "block",
  ...props
}: React.ComponentProps<"div"> & { shape?: "block" | "circle" }) {
  return (
    <div
      data-slot="skeleton"
      data-shape={shape}
      className={cn("ui-skeleton", className)}
      {...props}
    />
  );
}

export { Skeleton };
