import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleEqual,
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
  "Duplicate",
] as const;

/**
 * Statuses a person or agent can choose directly. Duplicate is not among them: marking one
 * needs a canonical ticket, so it goes through the duplicate review instead.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const directStatuses = ticketStatuses.filter(
  (status) => status !== "Duplicate",
);

const statusIcons: Record<string, LucideIcon> = {
  Todo: Circle,
  "In progress": CircleDot,
  "In review": CircleDashed,
  Done: CircleCheck,
  Canceled: CircleSlash,
  Duplicate: CircleEqual,
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
