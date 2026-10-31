import { formatTime, startOfLocalDay } from "@/lib/format";

/**
 * A short trigger label such as "Tomorrow, 9:00 AM" for a scheduled reminder,
 * or "Reminder due" once its time has passed and it is waiting in the inbox.
 */
export function reminderSummary(due: string, now = new Date()): string {
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) return "Reminder set";
  if (date.getTime() <= now.getTime()) return "Reminder due";
  const days = Math.round(
    (startOfLocalDay(date) - startOfLocalDay(now)) / 86400000,
  );
  const day =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            ...(date.getFullYear() === now.getFullYear()
              ? {}
              : { year: "numeric" }),
          });
  return `${day}, ${formatTime(date)}`;
}
