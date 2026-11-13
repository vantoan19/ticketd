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
    on_failure: [
      {
        id: "on-failure",
        kind: "notify" as const,
        text: "Done",
        opens: "ticket" as const,
      },
    ],
  },
  {
    id: "if",
    kind: "if" as const,
    checks: [],
    yes: [
      {
        id: "yes",
        kind: "notify" as const,
        text: "Done",
        opens: "ticket" as const,
      },
    ],
    no: [
      {
        id: "no",
        kind: "notify" as const,
        text: "Done",
        opens: "ticket" as const,
      },
    ],
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
      needs_you: false,
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
        chat_owned: false,
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
  automation_id: "automation-1",
  status: "completed",
  reason: null,
  needs_you: false,
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
    needs_you: status === "needs_attention",
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
  // A run the person dismissed no longer needs them, and an empty group is left out.
  expect(
    runsByNeed([{ ...of("a", "needs_attention"), needs_you: false }]).map(
      (group) => group.label,
    ),
  ).toEqual(["Earlier"]);
});
