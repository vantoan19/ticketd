import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleEqual,
  CircleSlash,
  type LucideIcon,
} from "lucide-react";

const statusIcons: Record<string, LucideIcon> = {
  Todo: Circle,
  "In progress": CircleDot,
  "In review": CircleDashed,
  Done: CircleCheck,
  Canceled: CircleSlash,
  Duplicate: CircleEqual,
};

/** The glyph of a status; Canceled and Duplicate never share Done’s. */
export const statusIconFor = (status: string): LucideIcon =>
  statusIcons[status] ?? Circle;

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
  const Icon = statusIcons[status] ?? Circle;
  return decorative ? (
    <Icon aria-hidden="true" size={size} className={className} />
  ) : (
    <Icon role="img" aria-label={status} size={size} className={className} />
  );
}
