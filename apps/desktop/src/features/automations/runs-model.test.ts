import { expect, test } from "vitest";
import type {
  AutomationRun,
  AutomationRunDetail,
} from "@/features/automations/client";
import {
  runsByDay,
  runsByNeed,
  stepStates,
} from "@/features/automations/runs-model";

/** An agent step with a failure path, then an If with a step on each path. */
const BRANCHING = [
  {
    id: "agent",
    kind: "run_agent" as const,
    agent_id: "agent-1",
    execution_folder: "/work",
    on_failure: [{ id: "on-failure", kind: "notify" as const }],
  },
  {
    id: "if",
    kind: "if" as const,
    yes: [{ id: "yes", kind: "notify" as const }],
    no: [{ id: "no", kind: "notify" as const }],
  },
];
const states = (
  status: AutomationRunDetail["status"],
  reached: Record<string, "running" | "completed" | "failed">,
) =>
  Object.fromEntries(
    stepStates({
      id: "run-1",
      automation_id: "automation-1",
      status,
      reason: null,
      ticket: null,
      created_at: "2026-11-14T10:00:00.000Z",
      started_at: null,
      ended_at: null,
      definition: {
        name: "Verify",
        trigger: null,
        conditions: [],
        steps: BRANCHING,
      },
      steps: Object.entries(reached).map(([step_id, status]) => ({
        step_id,
        status,
        reason: null,
        chat_id: null,
        started_at: "2026-11-14T10:00:00.000Z",
        ended_at: null,
      })),
    }),
  );

test("while a run is going, the steps it can still reach are Waiting", () => {
  expect(states("running", { agent: "running" })).toEqual({
    agent: "running",
    "on-failure": "waiting",
    if: "waiting",
    yes: "waiting",
    no: "waiting",
  });
});

test("a path the run has passed is Not run, though the run is still going", () => {
  expect(
    states("running", { agent: "completed", if: "completed", yes: "running" }),
  ).toEqual({
    agent: "completed",
    "on-failure": "not_run",
    if: "completed",
    yes: "running",
    no: "not_run",
  });
});

test("once a run has ended, every step it did not reach is Not run", () => {
  expect(
    states("completed", { agent: "failed", "on-failure": "completed" }),
  ).toEqual({
    agent: "failed",
    "on-failure": "completed",
    if: "not_run",
    yes: "not_run",
    no: "not_run",
  });
});

const run = (id: string, created_at: string): AutomationRun => ({
  id,
  status: "completed",
  reason: null,
  ticket: null,
  created_at,
});

test("runs are grouped by the local day they started on, newest day first", () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime();
  const at = (day: number, hour: number) =>
    new Date(2026, 10, day, hour, 0).toISOString();

  const days = runsByDay(
    [
      run("a", at(14, 14)),
      run("b", at(14, 0)),
      run("c", at(13, 23)),
      run("d", at(11, 9)),
      run("e", at(11, 8)),
    ],
    now,
  );

  expect(
    days.map((day) => [day.label, day.runs.map((item) => item.id)]),
  ).toEqual([
    ["Today", ["a", "b"]],
    ["Yesterday", ["c"]],
    ["Nov 11", ["d", "e"]],
  ]);
});

test("every run is grouped by whether it is going, needs the person, or is over, in the order given", () => {
  const of = (id: string, status: AutomationRun["status"]) => ({
    ...run(id, "2026-11-14T10:00:00Z"),
    status,
  });

  const groups = runsByNeed([
    of("a", "completed"),
    of("b", "queued"),
    of("c", "needs_attention"),
    of("d", "running"),
    of("e", "taken_over"),
  ]);

  expect(
    groups.map((group) => [group.label, group.runs.map((item) => item.id)]),
  ).toEqual([
    ["Now", ["b", "d"]],
    ["Needs you", ["c"]],
    ["Earlier", ["a", "e"]],
  ]);
  // A group with nothing in it is left out.
  expect(runsByNeed([of("a", "completed")]).map((g) => g.label)).toEqual([
    "Earlier",
  ]);
});
