import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, layoutContextGraph } from "./context-layout";
import {
  labelSize,
  placeLabels,
  routeAll,
  routePaths,
  segmentHitsRect,
  type Rect,
} from "./edge-routing";

/**
 * Seeded context graphs recorded from a 25-ticket Plan: its own context graph
 * and the workspace page. Each runs through the real layout and routing, and
 * the counts below may only go down.
 */
type Fixture = {
  nodes: string[];
  edges: [string, string, string][];
  center?: string;
};

const meets = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

function measure(name: string) {
  const graph = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;
  const edges = graph.edges.map(([source, target, label]) => ({
    id: `${source}>${target}${label}`,
    source,
    target,
    label,
  }));
  const points = layoutContextGraph({
    nodes: graph.nodes,
    edges,
    positions: {},
    ...(graph.center ? { center: graph.center } : {}),
  });
  const cards: Record<string, Rect> = {};
  for (const id of graph.nodes)
    cards[id] = {
      x: points[id]!.x - CARD_WIDTH / 2,
      y: points[id]!.y - CARD_HEIGHT / 2,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    };
  const routes = routeAll(cards, edges);
  let cardOverlaps = 0;
  for (let i = 0; i < graph.nodes.length; i++)
    for (let j = i + 1; j < graph.nodes.length; j++) {
      const a = points[graph.nodes[i]!]!;
      const b = points[graph.nodes[j]!]!;
      if (Math.abs(a.x - b.x) < CARD_WIDTH && Math.abs(a.y - b.y) < CARD_HEIGHT)
        cardOverlaps++;
    }
  let edgesThroughCards = 0;
  let routed = 0;
  let straight = 0;
  let bends = 0;
  let labelsOverCards = 0;
  let labelsOverLabels = 0;
  const placed: Rect[] = [];
  for (const edge of edges) {
    const route = routes[edge.id]!;
    const crossesCard = Object.entries(cards).some(
      ([id, card]) =>
        id !== edge.source &&
        id !== edge.target &&
        route.points.some(
          (point, i) =>
            i + 1 < route.points.length &&
            segmentHitsRect(point, route.points[i + 1]!, card),
        ),
    );
    if (crossesCard) edgesThroughCards++;
    for (let i = 0; i + 1 < route.points.length; i++)
      routed += Math.hypot(
        route.points[i + 1]!.x - route.points[i]!.x,
        route.points[i + 1]!.y - route.points[i]!.y,
      );
    straight += Math.hypot(
      points[edge.target]!.x - points[edge.source]!.x,
      points[edge.target]!.y - points[edge.source]!.y,
    );
    bends += route.points.length - 2;
    const size = labelSize(edge.label);
    const box = {
      x: route.label.x - size.width / 2,
      y: route.label.y - size.height / 2,
      ...size,
    };
    if (Object.values(cards).some((card) => meets(box, card)))
      labelsOverCards++;
    labelsOverLabels += placed.filter((other) => meets(box, other)).length;
    placed.push(box);
  }
  // The canvas names only the lines of the selected card, so what a reader
  // meets is the labels of one card's lines at a time. Count them card by card.
  const paths = routePaths(cards, edges);
  let selectedOverCards = 0;
  let selectedOverLabels = 0;
  for (const id of graph.nodes) {
    const shown = edges.filter(
      (edge) => edge.source === id || edge.target === id,
    );
    const spots = placeLabels(cards, paths, shown);
    const boxes = shown.map((edge) => {
      const size = labelSize(edge.label);
      const at = spots[edge.id]!.label;
      return { x: at.x - size.width / 2, y: at.y - size.height / 2, ...size };
    });
    selectedOverCards += boxes.filter((box) =>
      Object.values(cards).some((card) => meets(box, card)),
    ).length;
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        if (meets(boxes[i]!, boxes[j]!)) selectedOverLabels++;
  }
  return {
    selectedOverCards,
    selectedOverLabels,
    nodes: graph.nodes.length,
    edges: edges.length,
    cardOverlaps,
    edgesThroughCards,
    labelsOverCards,
    labelsOverLabels,
    detour: Math.round((routed / straight) * 100) / 100,
    bends,
  };
}

// Counts measured when this test was written, on the real layout and routing.
// Before: Plan 29 lines through cards, 13 labels over cards; workspace page
// 59, 33 and 6 labels over labels. Lower them only.
const BOUNDS = {
  "plan-context": {
    edgesThroughCards: 0,
    labelsOverCards: 7,
    labelsOverLabels: 2,
    selectedOverCards: 0,
    selectedOverLabels: 0,
  },
  "workspace-page": {
    edgesThroughCards: 0,
    labelsOverCards: 4,
    labelsOverLabels: 0,
    selectedOverCards: 4,
    selectedOverLabels: 0,
  },
} as const;

test.each([
  ["plan-context", 29, 54],
  ["workspace-page", 50, 90],
] as const)(
  "%s: lines avoid cards and labels avoid cards",
  (name, nodes, edges) => {
    const result = measure(name);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
    expect(result.cardOverlaps).toBe(0);
    const bound = BOUNDS[name];
    expect(result.edgesThroughCards).toBeLessThanOrEqual(
      bound.edgesThroughCards,
    );
    expect(result.labelsOverCards).toBeLessThanOrEqual(bound.labelsOverCards);
    expect(result.labelsOverLabels).toBeLessThanOrEqual(bound.labelsOverLabels);
    expect(result.selectedOverCards).toBeLessThanOrEqual(
      bound.selectedOverCards,
    );
    expect(result.selectedOverLabels).toBeLessThanOrEqual(
      bound.selectedOverLabels,
    );
  },
);
