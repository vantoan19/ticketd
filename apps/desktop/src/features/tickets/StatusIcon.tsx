import { useLayoutEffect, useRef } from "react";
import { Circle } from "lucide-react";
import { statusIcons } from "./status-icons";

/** The icon for a ticket status. Named by the status unless it sits beside the status word. */
export function StatusIcon({
  status,
  size = 16,
  className,
  decorative = false,
}: {
  status: string;
  size?: number;
  className?: string;
  decorative?: boolean;
}) {
  const element = useRef<SVGSVGElement>(null);
  const previousStatus = useRef(status);
  useLayoutEffect(() => {
    // Initial lists and historical events stay still; only a changed status sweeps.
    if (previousStatus.current !== status) {
      const sweep: Record<string, number> = {
        "In progress": 180,
        "In review": 270,
        Done: 360,
      };
      const from = sweep[previousStatus.current] ?? 0;
      element.current?.style.setProperty("--status-from", `${from}deg`);
      element.current?.classList.add("is-changing");
      previousStatus.current = status;
    }
  }, [status]);
  const Icon = statusIcons[status] ?? Circle;
  return decorative ? (
    <Icon ref={element} aria-hidden="true" size={size} className={className} />
  ) : (
    <Icon
      ref={element}
      role="img"
      aria-label={status}
      size={size}
      className={className}
    />
  );
}
