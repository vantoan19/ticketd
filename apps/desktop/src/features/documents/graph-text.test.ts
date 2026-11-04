import { expect, test } from "vitest";
import { connectionRows, describeEdge, plainText } from "./graph-text";

const nodes = [
  {
    id: "a",
    kind: "ticket" as const,
    label: "T-1 · A",
    ticket_reference: "T-1",
  },
  {
    id: "b",
    kind: "ticket" as const,
    label: "T-2 · B",
    ticket_reference: "T-2",
  },
  { id: "p", kind: "plan" as const, label: "Launch", ticket_reference: null },
].map((node) => ({
  ...node,
  state: null,
  trashed: false,
  activity_detail: false,
}));

test("passages show link text without Markdown or ticketd URLs", () => {
  expect(
    plainText("See [capture context](ticketd://document/abc) and T-1."),
  ).toBe("See capture context and T-1.");
});

test("edges state direction in plain language and rows are one per relationship", () => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  expect(
    describeEdge(
      { source: "a", target: "b", kind: "blocks", explanation: null },
      byId,
    ),
  ).toBe("T-1 must be Done before T-2 is Ready");
  expect(
    describeEdge(
      { source: "p", target: "a", kind: "membership", explanation: null },
      byId,
    ),
  ).toBe("T-1 is in plan Launch");
  const rows = connectionRows("b", {
    nodes,
    edges: [
      { source: "a", target: "b", kind: "mention", explanation: "one" },
      { source: "a", target: "b", kind: "mention", explanation: "two" },
    ],
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.text).toBe("T-1 mentions T-2: “one” (+1 more)");
});
