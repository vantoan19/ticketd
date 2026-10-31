import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  type LucideIcon,
} from "lucide-react";

// Kept beside the icon that renders it; Fast Refresh only affects dev reloads.
// eslint-disable-next-line react-refresh/only-export-components
export const ticketStatuses = [
  "Todo",
  "In progress",
  "In review",
  "Done",
  "Canceled",
] as const;

const statusIcons: Record<string, LucideIcon> = {
  Todo: Circle,
  "In progress": CircleDot,
  "In review": CircleDashed,
  Done: CircleCheck,
  Canceled: CircleSlash,
};

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
