/** A short trigger label such as "Tomorrow, 9:00" for a scheduled reminder. */
export function reminderSummary(due: string, now = new Date()): string {
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) return "Reminder set";
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
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
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${day}, ${time}`;
}
