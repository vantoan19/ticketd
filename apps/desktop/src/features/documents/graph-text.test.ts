import { describe, expect, it, test } from "vitest";
import {
  centerZoom,
  connectionRows,
  describeEdge,
  opensAsMap,
  panToInclude,
  plainText,
  stateLine,
} from "./graph-text";

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
  ).toBe("T-1 is in Plan Launch");
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

test("every relationship kind has a style and styles differ by dash and colour", async () => {
  const { edgeStyle, edgeStyles, edgeLabels } = await import("./graph-text");
  for (const kind of Object.keys(edgeLabels))
    expect(edgeStyle(kind)).toBeTruthy();
  expect(new Set(edgeStyles.map((s) => `${s.dash}|${s.color}`)).size).toBe(
    edgeStyles.length,
  );
  expect(edgeStyle("spec").name).toMatch(/Primary spec/);
});

describe("map rules", () => {
  it("opens crowded neighbourhoods as a list and lets the person choose a map", () => {
    expect(opensAsMap(12, null)).toBe(true);
    expect(opensAsMap(13, null)).toBe(false);
    expect(opensAsMap(13, true)).toBe(true);
    expect(opensAsMap(12, false)).toBe(false);
    expect(opensAsMap(31, true)).toBe(false);
    expect(opensAsMap(80, true, 100)).toBe(true);
  });
  it("never centers below a readable zoom", () => {
    expect(centerZoom(0.3)).toBe(0.6);
    expect(centerZoom(1.2)).toBe(1.2);
  });
  it("pans just enough to include new cards without changing zoom", () => {
    const view = { x: 0, y: 0, zoom: 1 };
    const size = { width: 500, height: 400 };
    expect(
      panToInclude(view, size, { x: 40, y: 40, width: 100, height: 50 }),
    ).toEqual(view);
    expect(
      panToInclude(view, size, { x: 450, y: 40, width: 100, height: 50 }),
    ).toEqual({
      x: -74,
      y: 0,
      zoom: 1,
    });
  });
  it("keeps the cards already in view fully visible when panning to new ones", () => {
    const view = { x: 0, y: 0, zoom: 1 };
    const size = { width: 500, height: 400 };
    const keep = { x: 24, y: 24, width: 100, height: 50 };
    // Both fit: pan only as far as needed to show the new card too.
    expect(
      panToInclude(
        view,
        size,
        { x: 24, y: 300, width: 100, height: 50 },
        24,
        keep,
      ),
    ).toEqual(view);
    // Both fit only when zooming out: the zoom drops, the top row stays visible.
    const out = panToInclude(
      view,
      size,
      { x: 24, y: 500, width: 100, height: 50 },
      24,
      keep,
    );
    expect(out.zoom).toBeLessThan(1);
    expect(out.zoom).toBeGreaterThanOrEqual(0.6);
    expect(24 * out.zoom + out.y).toBeGreaterThanOrEqual(24);
    expect(550 * out.zoom + out.y).toBeLessThanOrEqual(400 - 24);
  });
  it("words an attached Document without a quote and skips empty state parts", () => {
    const nodes = new Map([
      [
        "t",
        {
          id: "t",
          kind: "ticket",
          label: "T-9 · A",
          ticket_reference: "T-9",
          state: null,
          trashed: false,
          activity_detail: false,
        },
      ],
      [
        "d",
        {
          id: "d",
          kind: "document",
          label: "Linked",
          state: null,
          trashed: false,
          activity_detail: false,
        },
      ],
    ] as const);
    expect(
      describeEdge(
        { source: "t", target: "d", kind: "attached", explanation: null },
        nodes as never,
      ),
    ).toBe("T-9 has Linked");
    expect(
      stateLine({ state: null, trashed: false, activity_detail: true }),
    ).toBe("Update details");
  });
});

test("a passage differing from the title only by punctuation is not repeated", () => {
  const nodes = new Map([
    [
      "a",
      {
        id: "a",
        kind: "document",
        label: "Dense shared reference",
        state: null,
        trashed: false,
        activity_detail: false,
      },
    ],
    [
      "b",
      {
        id: "b",
        kind: "ticket",
        label: "Step",
        state: null,
        trashed: false,
        activity_detail: false,
      },
    ],
  ] as never) as Map<string, never>;
  expect(
    describeEdge(
      {
        source: "b",
        target: "a",
        kind: "mention",
        explanation: "dense shared reference.",
      } as never,
      nodes,
    ),
  ).not.toContain("“");
});
