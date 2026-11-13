import { expect, test } from "vitest";
import { layoutFlow } from "@/features/automations/canvas-layout";

test("a straight flow puts each step directly below the one before, with a + on every line and at the end", () => {
  const layout = layoutFlow([{ id: "a" }, { id: "b" }]);

  // In the order the steps run, which is also the Tab order.
  expect(layout.items).toEqual([
    { kind: "card", id: "trigger", x: 0, y: 0 },
    { kind: "add", id: "add-0", index: 0, after: "trigger", x: 0, y: 76 },
    { kind: "card", id: "a", x: 0, y: 132 },
    { kind: "add", id: "add-1", index: 1, after: "a", x: 0, y: 208 },
    { kind: "card", id: "b", x: 0, y: 264 },
    { kind: "end", id: "add-2", index: 2, after: "b", x: 104, y: 396 },
  ]);
  expect(layout.edges).toEqual([
    { id: "trigger>a", source: "trigger", target: "a" },
    { id: "a>b", source: "a", target: "b" },
    { id: "b>add-2", source: "b", target: "add-2" },
  ]);
});

test("a new Automation is a trigger and one +", () => {
  expect(layoutFlow([])).toEqual({
    items: [
      { kind: "card", id: "trigger", x: 0, y: 0 },
      { kind: "end", id: "add-0", index: 0, after: "trigger", x: 104, y: 132 },
    ],
    edges: [{ id: "trigger>add-0", source: "trigger", target: "add-0" }],
  });
});

const cards = (layout: ReturnType<typeof layoutFlow>) =>
  Object.fromEntries(
    layout.items
      .filter((item) => item.kind === "card")
      .map((item) => [item.id, [item.x, item.y]]),
  );

test("an If puts its Yes and No paths side by side below it, and a failure path to the side of everything under its step", () => {
  const layout = layoutFlow([
    { id: "agent", on_failure: [{ id: "tell-me" }] },
    { id: "if", yes: [{ id: "y1" }, { id: "y2" }], no: [{ id: "n1" }] },
  ]);

  expect(cards(layout)).toEqual({
    // The flow's own steps stay directly above one another, over the middle
    // of the two paths.
    trigger: [144, 0],
    agent: [144, 132],
    if: [144, 264],
    // Each path is a column of its own, each step directly above the next.
    y1: [0, 416],
    y2: [0, 548],
    n1: [288, 416],
    // Beside the step that failed, one row down, clear of the paths.
    "tell-me": [576, 264],
  });
  // The trigger, each step top to bottom, a failure path after its step, Yes
  // before No: the Tab order.
  expect(Object.keys(cards(layout))).toEqual([
    "trigger",
    "agent",
    "tell-me",
    "if",
    "y1",
    "y2",
    "n1",
  ]);
  expect(
    layout.edges.filter((edge) => !edge.target.startsWith("add-")),
  ).toEqual([
    { id: "trigger>agent", source: "trigger", target: "agent" },
    {
      id: "agent>tell-me",
      source: "agent",
      target: "tell-me",
      path: "failure",
    },
    { id: "agent>if", source: "agent", target: "if" },
    { id: "if>y1", source: "if", target: "y1", path: "yes" },
    { id: "if>n1", source: "if", target: "n1", path: "no" },
    { id: "y1>y2", source: "y1", target: "y2" },
  ]);
  // Every path ends in its own +, which says which list it adds to.
  expect(layout.items.filter((item) => item.kind === "end")).toEqual([
    {
      kind: "end",
      id: "add-agent.failure-1",
      index: 1,
      after: "tell-me",
      list: { step: "agent", path: "failure" },
      x: 680,
      y: 396,
    },
    {
      kind: "end",
      id: "add-if.yes-2",
      index: 2,
      after: "y2",
      list: { step: "if", path: "yes" },
      x: 104,
      y: 680,
    },
    {
      kind: "end",
      id: "add-if.no-1",
      index: 1,
      after: "n1",
      list: { step: "if", path: "no" },
      x: 392,
      y: 548,
    },
  ]);
});

test("a nested If widens its side, and the If above stays over the middle of its two paths", () => {
  const layout = layoutFlow(
    [
      {
        id: "outer",
        yes: [{ id: "inner", yes: [{ id: "a" }], no: [{ id: "b" }] }],
        no: [{ id: "c" }],
      },
    ],
    // Cards that also carry a status line, as in a run.
    96,
  );

  expect(cards(layout)).toEqual({
    trigger: [360, 0],
    outer: [360, 152],
    inner: [144, 324],
    c: [576, 324],
    a: [0, 496],
    b: [288, 496],
  });
});
