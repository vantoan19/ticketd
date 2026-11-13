import { expect, test } from "vitest";
import type { AutomationRun } from "@/features/automations/client";
import { runsByDay } from "@/features/automations/runs-model";

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
