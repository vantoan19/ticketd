import type { AutomationRun } from "@/features/automations/client";

/** A run's status in the words the interface uses. */
export const RUN_STATUS_LABELS: Record<AutomationRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  needs_attention: "Needs attention",
  taken_over: "Taken over",
};

export type RunDay = { label: string; runs: AutomationRun[] };

/**
 * Runs under the local day they started on: "Today", "Yesterday", then the date.
 * `runs` arrive newest first and stay in that order.
 */
export function runsByDay(runs: AutomationRun[], now = Date.now()): RunDay[] {
  const today = new Date(now).toDateString();
  const yesterday = new Date(now - 86_400_000).toDateString();
  const days: RunDay[] = [];
  for (const run of runs) {
    const started = new Date(run.created_at);
    const day = started.toDateString();
    const label =
      day === today
        ? "Today"
        : day === yesterday
          ? "Yesterday"
          : started.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });
    const last = days.at(-1);
    if (last?.label === label) last.runs.push(run);
    else days.push({ label, runs: [run] });
  }
  return days;
}
