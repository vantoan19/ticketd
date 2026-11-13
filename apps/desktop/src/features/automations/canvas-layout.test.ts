import { expect, test } from "vitest";
import { layoutFlow } from "@/features/automations/canvas-layout";

test("a straight flow puts each step directly below the one before, with a + on every line and at the end", () => {
  const layout = layoutFlow(["a", "b"]);

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
