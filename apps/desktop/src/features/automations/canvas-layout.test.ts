import { expect, test } from "vitest";
import {
  layoutFlow,
  automaticViewport,
  focusZoom,
  LEAST_ZOOM,
  readableViewport,
} from "@/features/automations/canvas-layout";

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

test("a step with a failure path keeps its next step directly below it, and the path starts beside them", () => {
  // A path just added, with nothing on it yet: only its +.
  const added = layoutFlow([{ id: "a", on_failure: [] }, { id: "b" }]);

  expect(cards(added)).toEqual({
    trigger: [0, 0],
    a: [0, 132],
    b: [0, 264],
  });
  expect(added.items.filter((item) => item.kind === "end")).toEqual([
    // Level with the next step and clear of it, so the line from the side of
    // "a" turns down once and crosses nothing.
    {
      kind: "end",
      id: "add-a.failure-0",
      index: 0,
      after: "a",
      list: { step: "a", path: "failure" },
      x: 392,
      y: 264,
    },
    { kind: "end", id: "add-2", index: 2, after: "b", x: 104, y: 396 },
  ]);
  expect(added.edges).toEqual([
    { id: "trigger>a", source: "trigger", target: "a" },
    {
      id: "a>add-a.failure-0",
      source: "a",
      target: "add-a.failure-0",
      path: "failure",
    },
    { id: "a>b", source: "a", target: "b" },
    { id: "b>add-2", source: "b", target: "add-2" },
  ]);

  // Steps on the path, one with a failure path of its own, widen only the side.
  const filled = layoutFlow([
    { id: "a", on_failure: [{ id: "f1", on_failure: [{ id: "f2" }] }] },
    { id: "b" },
  ]);
  expect(cards(filled)).toEqual({
    trigger: [0, 0],
    a: [0, 132],
    f1: [288, 264],
    f2: [576, 396],
    b: [0, 264],
  });
});

test("in the editor a nested If gives every path its own +, and nothing is added after an If", () => {
  const layout = layoutFlow([
    { id: "agent" },
    {
      id: "outer",
      yes: [{ id: "done" }],
      // A new If: both paths still empty.
      no: [{ id: "inner", yes: [], no: [] }],
    },
  ]);

  expect(cards(layout)).toEqual({
    // Over the middle of the Yes column (axis 120) and the nested If (552).
    trigger: [216, 0],
    agent: [216, 132],
    outer: [216, 264],
    done: [0, 416],
    inner: [432, 416],
  });
  // Where a step can be added, in Tab order: the list it joins and the place
  // in it. A path that holds an If ends there, so it has no + of its own.
  expect(
    layout.items.flatMap((item) =>
      item.kind === "card"
        ? []
        : [
            `${item.kind} ${item.list ? `${item.list.step}.${item.list.path}` : "flow"}[${item.index}] after ${item.after}`,
          ],
    ),
  ).toEqual([
    "add flow[0] after trigger",
    "add flow[1] after agent",
    "add outer.yes[0] after outer",
    "end outer.yes[1] after done",
    "add outer.no[0] after outer",
    "end inner.yes[0] after inner",
    "end inner.no[0] after inner",
  ]);
  // The two + of the empty If sit side by side, each under its own line.
  expect(
    layout.items.filter((item) => item.kind === "end").map((item) => item.x),
  ).toEqual([104, 392, 680]);
  expect(layout.edges.filter((edge) => edge.path)).toEqual([
    { id: "outer>done", source: "outer", target: "done", path: "yes" },
    { id: "outer>inner", source: "outer", target: "inner", path: "no" },
    {
      id: "inner>add-inner.yes-0",
      source: "inner",
      target: "add-inner.yes-0",
      path: "yes",
    },
    {
      id: "inner>add-inner.no-0",
      source: "inner",
      target: "add-inner.no-0",
      path: "no",
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

test("a flow only too tall to read whole is still centred across, so a failure path on its right stays in view", () => {
  // 896 by 1400 is 672 by 1050 at the readable 75%: as wide as fits 687.
  const flow = { x: 0, y: 0, width: 896, height: 1400 };
  const trigger = { x: 0, y: 0, width: 240, height: 76 };

  const view = readableViewport(
    flow,
    trigger,
    { width: 687, height: 600 },
    true,
  );

  // Centred on the whole flow, not on the trigger at its left.
  expect(view.x).toBeCloseTo(687 / 2 - (896 / 2) * 0.75);
  // The top of the flow below the canvas's top edge.
  expect(view.y).toBe(32);
});

test("a flow too wide to read whole shows the chosen card, but never scrolls past the flow's ends", () => {
  const flow = { x: 0, y: 0, width: 2000, height: 400 };
  // The chosen card at the left end: centring it would show empty canvas.
  const card = { x: 0, y: 200, width: 240, height: 76 };

  const view = readableViewport(flow, card, { width: 600, height: 800 }, false);

  expect(view.x).toBe(16);
});

test("a selected card whose failure path does not fit beside it is shown whole at the left, its path going on to the right", () => {
  const flow = { x: -200, y: 0, width: 1400, height: 400 };
  // The card at x 0 and the first step of its failure path, 760 wide together.
  const focus = { x: 0, y: 100, width: 760, height: 76 };

  const view = readableViewport(
    flow,
    focus,
    { width: 540, height: 800 },
    false,
  );

  expect(view.x).toBe(16);
});

test("a selected card and the first step of its failure path are shown together beside the panel, below the readable size if need be but not below half", () => {
  // A Run agent card with its failure path, as an editor 1280 px wide shows it
  // with the panel open: a canvas 363 px wide (round 2's M7).
  const layout = layoutFlow([{ id: "agent", on_failure: [{ id: "retry" }] }]);
  const at = (id: string) => {
    const item = layout.items.find((found) => found.id === id)!;
    return { x: item.x, y: item.y, width: 240, height: 76 };
  };
  const agent = at("agent");
  const retry = at("retry");
  const focus = {
    x: agent.x,
    y: agent.y,
    width: retry.x + retry.width - agent.x,
    height: retry.y + retry.height - agent.y,
  };
  const flow = { x: 0, y: 0, width: focus.x + focus.width, height: 600 };
  const canvas = { width: 363, height: 640 };

  const zoom = focusZoom(focus, canvas);
  const view = readableViewport(flow, focus, canvas, false, zoom);

  expect(zoom).toBeLessThan(0.75);
  expect(zoom).toBeGreaterThanOrEqual(0.5);
  expect(view.x + focus.x * zoom).toBeGreaterThanOrEqual(16);
  expect(view.x + (focus.x + focus.width) * zoom).toBeLessThanOrEqual(363 - 16);
  // Room enough at the readable size: it stays there.
  expect(focusZoom(focus, { width: 1200, height: 800 })).toBe(0.75);
  // Never below half, however narrow.
  expect(focusZoom(focus, { width: 200, height: 640 })).toBe(0.5);
});

test("the automatic view keeps the selected card whole and cuts no card in half at an edge", () => {
  // Round 3's flow (3A4, 3C3): Run agent with a failure path, then an If whose
  // No path holds another If.
  const layout = layoutFlow([
    { id: "agent", on_failure: [{ id: "tell" }] },
    {
      id: "check",
      yes: [{ id: "done" }],
      no: [{ id: "inner", yes: [{ id: "a" }], no: [{ id: "b" }] }],
    },
  ]);
  const cards = layout.items
    .filter((item) => item.kind === "card")
    .map((item) => ({ x: item.x, y: item.y, width: 240, height: 76 }));
  const at = (id: string) => {
    const item = layout.items.find((found) => found.id === id)!;
    return { x: item.x, y: item.y, width: 240, height: 76 };
  };
  const span = (
    boxes: { x: number; y: number; width: number; height: number }[],
  ) => {
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    return {
      x,
      y,
      width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
      height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
    };
  };
  const flow = span(cards);
  const agent = at("agent");
  const focus = span([agent, at("tell")]);

  // Beside the panel at 1280, 1100, 900 and 760 px windows, and at 720.
  for (const canvas of [
    { width: 363, height: 640 },
    { width: 520, height: 640 },
    { width: 700, height: 500 },
    { width: 300, height: 600 },
  ]) {
    const view = automaticViewport(
      flow,
      focus,
      canvas,
      false,
      focusZoom(focus, canvas),
      cards,
      agent,
    );
    const zoom = view.zoom;
    // Smaller only as it takes, never below the floor the canvas allows.
    expect(zoom).toBeGreaterThanOrEqual(LEAST_ZOOM);
    const screen = (box: typeof agent) => ({
      left: view.x + box.x * zoom,
      right: view.x + (box.x + box.width) * zoom,
      top: view.y + box.y * zoom,
      bottom: view.y + (box.y + box.height) * zoom,
    });
    const shown = screen(agent);
    expect(shown.left).toBeGreaterThanOrEqual(0);
    expect(shown.right).toBeLessThanOrEqual(canvas.width);
    for (const card of cards) {
      const { left, right, top, bottom } = screen(card);
      const cut = (low: number, high: number, edge: number) =>
        low < edge - 0.5 && high > edge + 0.5;
      expect(cut(left, right, 0) || cut(left, right, canvas.width)).toBe(false);
      expect(cut(top, bottom, 0) || cut(top, bottom, canvas.height)).toBe(
        false,
      );
    }
  }
});
