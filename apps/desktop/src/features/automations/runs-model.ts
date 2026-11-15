import type { FlowStep } from "@/features/automations/canvas-layout";
import {
  stepPaths,
  type AutomationRun,
  type AutomationRunDetail,
  type AutomationStep,
} from "@/features/automations/client";

/** Where a step of a run stands. A step the run did not reach has no record. */
export type StepState =
  "waiting" | "running" | "completed" | "failed" | "not_run";
export const STEP_STATE_LABELS: Record<StepState, string> = {
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  not_run: "Not run",
};

/**
 * Every step of the definition a run executes, by id, in the order they run. A
 * step the run has not reached is Waiting while the run can still get to it,
 * and Not run once it cannot: the run ended, or went down another path.
 */
export function stepStates(run: AutomationRunDetail): Map<string, StepState> {
  const reached = new Map(run.steps.map((step) => [step.step_id, step.status]));
  const states = new Map<string, StepState>();
  const walk = (steps: AutomationStep[], open: boolean) => {
    let live = open;
    for (const step of steps) {
      const status = reached.get(step.id);
      states.set(step.id, status ?? (live ? "waiting" : "not_run"));
      // Until the step ends, any path under it may still be the one taken.
      const undecided = live && status !== "completed" && status !== "failed";
      const { on_failure, yes, no } = stepPaths(step);
      for (const path of [on_failure, yes, no])
        if (path)
          walk(path, undecided || (live && reached.has(path[0]?.id ?? "")));
      // Paths never rejoin: after a failed step or an If, the rest is passed.
      if (status === "failed" || (status === "completed" && step.kind === "if"))
        live = false;
    }
  };
  walk(
    run.definition.steps,
    run.status === "queued" || run.status === "running",
  );
  return states;
}

/** The steps as the canvas layout takes them: ids and the paths under each. */
export function flowSteps(steps: AutomationStep[]): FlowStep[] {
  return steps.map((step) => {
    const { on_failure, yes, no } = stepPaths(step);
    return step.kind === "if"
      ? { id: step.id, yes: flowSteps(yes ?? []), no: flowSteps(no ?? []) }
      : {
          id: step.id,
          ...(on_failure && { on_failure: flowSteps(on_failure) }),
        };
  });
}

/** Every step at any depth, in the order they run. */
export function everyStep(steps: AutomationStep[]): AutomationStep[] {
  return steps.flatMap((step) => {
    const { on_failure, yes, no } = stepPaths(step);
    return [
      step,
      ...everyStep([...(on_failure ?? []), ...(yes ?? []), ...(no ?? [])]),
    ];
  });
}

/**
 * Where each step is, by id: its place among the steps of its own path, and
 * which path that is ("step 2 of 3", "Yes path, step 1 of 2"). Read in the
 * order the steps run, it turns the diagram into an outline.
 */
export function stepPlaces(steps: AutomationStep[]): Map<string, string> {
  const places = new Map<string, string>();
  const walk = (list: AutomationStep[], path: string) => {
    list.forEach((step, index) => {
      places.set(step.id, `${path}step ${index + 1} of ${list.length}`);
      const { on_failure, yes, no } = stepPaths(step);
      walk(on_failure ?? [], "Failure path, ");
      walk(yes ?? [], "Yes path, ");
      walk(no ?? [], "No path, ");
    });
  };
  walk(steps, "");
  return places;
}

/** A run's status in the words the interface uses. */
export const RUN_STATUS_LABELS: Record<AutomationRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  needs_attention: "Needs attention",
  taken_over: "Taken over",
};

/**
 * A run's status in words. A Needs attention run the person has answered says
 * how, so it no longer reads as asking for them.
 */
export function runStatusText(
  run: Pick<AutomationRun, "status" | "answer">,
): string {
  const label = RUN_STATUS_LABELS[run.status];
  if (run.answer === "dismissed") return `${label} · dismissed`;
  if (run.answer === "ran_again") return `${label} · run again`;
  return label;
}

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

/**
 * Runs under what they ask of the person: going now, waiting on them, or over.
 * A run that needed attention and was dismissed, run again or taken over is
 * over. `runs` arrive newest first, and the groups keep that order, except Now:
 * there the running runs come first, then the queued ones in the order they
 * start, oldest first. An empty group is left out.
 */
export function runsByNeed<Run extends AutomationRun>(runs: Run[]) {
  const need = (run: Run) =>
    run.status === "queued" || run.status === "running"
      ? "Now"
      : run.needs_you
        ? "Needs you"
        : "Earlier";
  const inGroup = (label: ReturnType<typeof need>) => {
    const members = runs.filter((run) => need(run) === label);
    return label === "Now"
      ? [
          ...members.filter((run) => run.status === "running"),
          ...members.filter((run) => run.status === "queued").reverse(),
        ]
      : members;
  };
  return (["Now", "Needs you", "Earlier"] as const)
    .map((label) => ({ label, runs: inGroup(label) }))
    .filter((group) => group.runs.length > 0);
}
