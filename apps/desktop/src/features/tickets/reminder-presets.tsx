import { Clock, Sun, Sunrise } from "lucide-react";
import { formatTime } from "@/lib/format";

/**
 * The reminder popover's common choices, resolved to a time: later today
 * (three hours on, on the hour, while today has room), tomorrow at 9:00, and
 * next Monday at 9:00.
 */
export function reminderPresets(now: Date) {
  const later = new Date(now);
  later.setMinutes(0, 0, 0);
  later.setHours(later.getHours() + 3);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const week = new Date(now);
  week.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  week.setHours(9, 0, 0, 0);
  return [
    ...(later.getDate() === now.getDate()
      ? [
          {
            key: "later",
            label: "Later today",
            at: later,
            meta: formatTime(later),
            icon: <Clock aria-hidden="true" />,
          },
        ]
      : []),
    {
      key: "tomorrow",
      label: "Tomorrow",
      at: tomorrow,
      meta: formatTime(tomorrow),
      icon: <Sunrise aria-hidden="true" />,
    },
    {
      key: "week",
      label: "Next week",
      at: week,
      meta: `${week.toLocaleDateString(undefined, { weekday: "short" })} ${formatTime(week)}`,
      icon: <Sun aria-hidden="true" />,
    },
  ];
}
