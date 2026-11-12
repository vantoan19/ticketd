import { describe, expect, it, test } from "vitest";
import {
  cardParts,
  centerZoom,
  connectionRows,
  describeEdge,
  flowEdges,
  labelledConnections,
  opensAsMap,
  panToInclude,
  plainText,
  stateLine,
  countNotFullyShown,
  isUserMove,
} from "./graph-text";

const nodes = [
  {
    id: "a",
    kind: "ticket" as const,
    label: "T-KQ1 · A",
    ticket_reference: "T-KQ1",
  },
  {
    id: "b",
    kind: "ticket" as const,
    label: "T-KQ2 · B",
    ticket_reference: "T-KQ2",
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
    plainText("See [capture context](ticketd://document/abc) and T-KQ1."),
  ).toBe("See capture context and T-KQ1.");
});

test("edges state direction in plain language and rows are one per relationship", () => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  expect(
    describeEdge(
      { source: "a", target: "b", kind: "blocks", explanation: null },
      byId,
    ),
  ).toBe("T-KQ1 must be Done before T-KQ2 is Ready");
  expect(
    describeEdge(
      { source: "p", target: "a", kind: "membership", explanation: null },
      byId,
    ),
  ).toBe("T-KQ1 is in Plan Launch");
  const rows = connectionRows("b", {
    nodes,
    edges: [
      { source: "a", target: "b", kind: "mention", explanation: "one" },
      { source: "a", target: "b", kind: "mention", explanation: "two" },
    ],
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.text).toBe("T-KQ1 mentions T-KQ2: “one” (+1 more)");
});

test("every relationship kind has a style and styles differ by dash and colour", async () => {
  const { edgeStyle, edgeStyles, edgeLabels } = await import("./graph-text");
  for (const kind of Object.keys(edgeLabels))
    expect(edgeStyle(kind)).toBeTruthy();
  // Colour never carries the meaning: every style is neutral and differs by dash and width.
  expect(new Set(edgeStyles.map((s) => `${s.dash}|${s.width}`)).size).toBe(
    edgeStyles.length,
  );
  expect(edgeStyles.every((s) => s.color === "currentColor")).toBe(true);
  expect(edgeStyle("spec").name).toMatch(/spec of/);
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
          label: "T-KQ9 · A",
          ticket_reference: "T-KQ9",
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
    ).toBe("T-KQ9 has Linked");
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

test("every edge is labeled on the line and nodes have no all-caps type prefix", () => {
  const edges = flowEdges(
    (["blocks", "mention", "subticket", "membership", "spec"] as const).map(
      (kind) => ({ source: "a", target: "b", kind, explanation: null }),
    ),
  );
  expect(edges.map((edge) => edge.label)).toEqual([
    "blocks",
    "mentions",
    "parent of",
    "in Plan",
    "spec of",
  ]);
  expect(
    cardParts({
      id: "t",
      kind: "ticket",
      label: "T-KQ3 · Redesign pricing page",
      state: "Todo",
      trashed: false,
      activity_detail: false,
    }),
  ).toEqual({
    ref: "T-KQ3",
    title: "Redesign pricing page",
    caption: "Ticket · Todo",
  });
});

test("a selection lists its connections under labelled rows, each item once", () => {
  const node = (id: string, ref: string, label: string) =>
    ({
      id,
      kind: "ticket",
      label: `${ref} · ${label}`,
      ticket_reference: ref,
      state: "Todo",
      trashed: false,
      activity_detail: false,
    }) as never;
  const edge = (kind: string, source: string, target: string) =>
    ({ kind, source, target, explanation: "" }) as never;
  const graph = {
    nodes: [
      node("a", "T-KQ1", "Add retries"),
      node("b", "T-KQ3", "Pricing"),
      node("c", "T-KQ8", "Jitter"),
    ],
    edges: [
      edge("blocks", "b", "a"),
      edge("subticket", "a", "c"),
      edge("mention", "b", "a"),
      edge("mention", "b", "a"),
    ],
  };
  expect(labelledConnections("a", graph)).toEqual([
    { label: "Blocked by", items: [{ id: "b", text: "T-KQ3 Pricing" }] },
    { label: "Parent of", items: [{ id: "c", text: "T-KQ8 Jitter" }] },
    { label: "Mentioned by", items: [{ id: "b", text: "T-KQ3 Pricing" }] },
  ]);
});

describe("countNotFullyShown", () => {
  const card = { width: 100, height: 50 };
  const view = { x: 0, y: 0, zoom: 1 };
  const size = { width: 400, height: 300 };
  it("counts wholly outside and partly clipped cards, not whole ones", () => {
    const cards = [
      { ...card, x: 10, y: 10 },
      { ...card, x: 350, y: 10 },
      { ...card, x: 500, y: 10 },
      { ...card, x: 10, y: 280 },
      { ...card, x: -20, y: 10 },
    ];
    expect(countNotFullyShown(cards, view, size)).toBe(4);
  });
  it("accounts for zoom and pan, and ignores an unsized canvas", () => {
    const cards = [{ ...card, x: 300, y: 0 }];
    expect(countNotFullyShown(cards, { x: 0, y: 0, zoom: 0.5 }, size)).toBe(0);
    expect(countNotFullyShown(cards, { x: -50, y: 0, zoom: 1 }, size)).toBe(0);
    expect(countNotFullyShown(cards, view, { width: 0, height: 0 })).toBe(0);
  });
});

describe("isUserMove", () => {
  it("is true only for a real DOM event", () => {
    expect(isUserMove(new Event("mousedown"))).toBe(true);
    expect(isUserMove({ sync: true })).toBe(false);
    expect(isUserMove(null)).toBe(false);
  });
});
