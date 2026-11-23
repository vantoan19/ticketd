import { demoReducer, initialDemo } from "./state";
import { expect, it } from "vitest";
import {
  demoTickets,
  dependentRef,
  featureRef,
  nextStage,
  planCounts,
  stages,
  type Stage,
} from "./workspace";

it("keeps the handoff, authored update, review and completion in order", () => {
  const sequence: Stage[] = [0, 1, 2, 3];
  expect(sequence.map(nextStage)).toEqual([1, 2, 3, 0]);
  for (const stage of sequence) {
    const tickets = demoTickets(stage);
    expect(tickets.map((t) => t.reference)).toEqual([
      "T-RL9",
      "T-RL10",
      "T-RL11",
      featureRef,
      dependentRef,
      "T-RL14",
    ]);
    expect(tickets.find((t) => t.reference === featureRef)).toMatchObject({
      status: stages[stage].status,
      editingAgent: stage === 1 || stage === 2 ? "coding-agent" : null,
    });
    expect(tickets.find((t) => t.reference === dependentRef)?.blocker).toBe(
      stage === 3 ? null : featureRef,
    );
    expect(planCounts(tickets).done).toBe(stage === 3 ? 2 : 1);
  }
  expect(demoTickets(0).find((t) => t.reference === featureRef)?.status).toBe(
    "Todo",
  );
});

it("stops autoplay when someone explores, and restores the guided view on play", () => {
  const handoff = demoReducer(initialDemo, { type: "tick" });
  const detail = demoReducer(handoff, {
    type: "ticket",
    reference: featureRef,
  });
  expect(demoReducer(detail, { type: "tick" })).toBe(detail);
  const spec = demoReducer(detail, { type: "pane", pane: "spec" });
  expect(spec).toMatchObject({
    stage: 1,
    pane: "spec",
    ticket: null,
    playing: false,
  });
  expect(demoReducer(spec, { type: "toggle" })).toMatchObject({
    stage: 1,
    pane: "plan",
    planView: "board",
    playing: true,
  });
  expect(demoReducer(detail, { type: "step", stage: 3 })).toMatchObject({
    stage: 3,
    pane: "plan",
    planView: "board",
    ticket: null,
    playing: false,
  });
});

it("returns to the same board column after inspecting a ticket or its Plan spec", () => {
  const board = demoReducer(initialDemo, { type: "plan-view", view: "board" });
  const working = demoReducer(board, { type: "column", status: "In progress" });
  const ticket = demoReducer(working, { type: "ticket", reference: "T-RL14" });
  const back = demoReducer(ticket, { type: "back" });
  const spec = demoReducer(back, { type: "pane", pane: "spec" });
  expect(demoReducer(spec, { type: "pane", pane: "plan" })).toMatchObject({
    planView: "board",
    boardColumn: "In progress",
  });
  expect(demoReducer(back, { type: "step", stage: 3 }).boardColumn).toBe(
    "Done",
  );
});

it("keeps read entries read when a new update arrives and rewinds them on replay", () => {
  const review = demoReducer(initialDemo, { type: "step", stage: 2 });
  const seen = demoReducer(review, { type: "read", ids: ["report"] });
  const accepted = demoReducer(seen, { type: "step", stage: 3 });
  expect(accepted.readEntries).toEqual(["report"]);
  const readAll = demoReducer(accepted, {
    type: "read",
    ids: ["start", "report", "review", "done"],
  });
  expect(demoReducer(readAll, { type: "step", stage: 1 }).readEntries).toEqual([
    "start",
  ]);
  expect(demoReducer(readAll, { type: "step", stage: 0 }).readEntries).toEqual(
    [],
  );
});
