import { expect, test } from "vitest";
import {
  borderPoint,
  labelSize,
  pathFor,
  placeLabel,
  routeAll,
  routeEdge,
  segmentHitsRect,
  type Rect,
} from "./edge-routing";

const card = (x: number, y: number): Rect => ({ x, y, width: 180, height: 72 });

test("a clear line stays straight and starts and ends on the card borders", () => {
  const points = routeEdge(card(0, 0), card(400, 0), []);
  expect(points).toHaveLength(2);
  expect(points[0]!.x).toBeCloseTo(180);
  expect(points[1]!.x).toBeCloseTo(400);
});

test("a card between the ends is bent around, never crossed", () => {
  const middle = card(0, 200);
  const points = routeEdge(card(0, 0), card(0, 400), [middle]);
  expect(points.length).toBeGreaterThan(2);
  for (let i = 0; i < points.length - 1; i++)
    expect(segmentHitsRect(points[i]!, points[i + 1]!, middle)).toBe(false);
});

test("a diagonal that clips a card's corner is rerouted", () => {
  const near = card(250, 120);
  const points = routeEdge(card(0, 0), card(500, 300), [near]);
  for (let i = 0; i < points.length - 1; i++)
    expect(segmentHitsRect(points[i]!, points[i + 1]!, near)).toBe(false);
});

test("a line goes the long way round a wall of cards instead of through it", () => {
  // A column of cards, closer together than the clearance, between the ends.
  const wall = [-3, -2, -1, 0, 1, 2, 3].map((row) => card(200, row * 80));
  const points = routeEdge(card(0, 0), card(500, 0), wall);
  expect(points.length).toBeGreaterThan(2);
  for (let i = 0; i < points.length - 1; i++)
    for (const rect of wall)
      expect(segmentHitsRect(points[i]!, points[i + 1]!, rect)).toBe(false);
});

test("a card enclosed by close neighbours still gets a line out between them", () => {
  const around = [
    card(-200, -80),
    card(-200, 80),
    card(200, -80),
    card(200, 80),
    card(0, -80),
    card(0, 80),
  ];
  const points = routeEdge(card(0, 0), card(600, 0), around);
  for (let i = 0; i < points.length - 1; i++)
    for (const rect of around)
      expect(segmentHitsRect(points[i]!, points[i + 1]!, rect)).toBe(false);
});

test("only edges with a label take room for one", () => {
  const cards = { a: card(0, 0), b: card(400, 0) };
  const routes = routeAll(cards, [
    { id: "1", source: "a", target: "b", label: "mentions" },
    { id: "2", source: "b", target: "a" },
  ]);
  // The unlabelled line has nothing to keep clear of, so it may share a midpoint.
  expect(routes["2"]!.points).toHaveLength(2);
  expect(routes["1"]!.label.x).toBeGreaterThan(180);
});

test("borderPoint leaves through the side facing the target", () => {
  expect(borderPoint(card(0, 0), { x: 1000, y: 36 })).toEqual({
    x: 180,
    y: 36,
  });
  expect(borderPoint(card(0, 0), { x: 90, y: -500 }).y).toBeCloseTo(0);
});

test("a label is moved off a card that sits on the middle of its line", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
  ];
  const blocker = { x: 170, y: -20, width: 60, height: 40 };
  const at = placeLabel(points, { width: 60, height: 18 }, [blocker]);
  const box = { x: at.x - 30, y: at.y - 9, width: 60, height: 18 };
  const touches =
    box.x < blocker.x + blocker.width &&
    blocker.x < box.x + box.width &&
    box.y < blocker.y + blocker.height &&
    blocker.y < box.y + box.height;
  expect(touches).toBe(false);
});

test("a label stays on its line when every point of the line is covered by cards", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 24, y: 40 },
  ];
  const cards = [
    { x: -100, y: -100, width: 100, height: 100 },
    { x: 24, y: 40, width: 100, height: 100 },
    { x: -100, y: 20, width: 124, height: 20 },
  ];
  const at = placeLabel(points, { width: 60, height: 18 }, cards);
  // On the line, never lifted above or below it.
  expect(at.y).toBeGreaterThanOrEqual(0);
  expect(at.y).toBeLessThanOrEqual(40);
  expect(at.x / 24).toBeCloseTo(at.y / 40);
});

test("labels of edges that share a line do not sit on each other", () => {
  const cards = { a: card(0, 0), b: card(400, 0) };
  const routes = routeAll(cards, [
    { id: "1", source: "a", target: "b", label: "mentions" },
    { id: "2", source: "b", target: "a", label: "mentions" },
  ]);
  const one = routes["1"]!.label;
  const two = routes["2"]!.label;
  expect(Math.abs(one.x - two.x) >= 54 || Math.abs(one.y - two.y) >= 18).toBe(
    true,
  );
});

test("pathFor rounds bends and keeps both ends", () => {
  const d = pathFor([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);
  expect(d.startsWith("M 0 0")).toBe(true);
  expect(d.endsWith("L 100 100")).toBe(true);
  expect(d).toContain("Q 100 0");
});

const touches = (at: { x: number; y: number }, text: string, rect: Rect) => {
  const size = labelSize(text);
  return (
    at.x - size.width / 2 < rect.x + rect.width &&
    rect.x < at.x + size.width / 2 &&
    at.y - size.height / 2 < rect.y + rect.height &&
    rect.y < at.y + size.height / 2
  );
};

test("a mention label stays off every card when a third card hugs the line", () => {
  // Spec on the left, two tickets stacked right beside its path to T-KQ3.
  const cards = {
    spec: { x: 0, y: 100, width: 180, height: 72 },
    t3: { x: 300, y: 100, width: 180, height: 72 },
    t2: { x: 150, y: 0, width: 180, height: 90 },
    t1: { x: 150, y: 182, width: 180, height: 90 },
  };
  const routes = routeAll(cards, [
    { id: "e", source: "spec", target: "t3", label: "mentions" },
  ]);
  const at = routes["e"]!.label;
  for (const rect of Object.values(cards))
    expect(touches(at, "mentions", rect)).toBe(false);
});

test("a blocks label between cards that nearly touch sits on its line, over the cards", () => {
  const cards = {
    a: { x: 0, y: 0, width: 180, height: 72 },
    b: { x: 200, y: 0, width: 180, height: 72 },
  };
  const routes = routeAll(cards, [
    { id: "e", source: "a", target: "b", label: "blocks" },
  ]);
  const route = routes["e"]!;
  // Too little room for the pill: it stays on the line rather than leaving it.
  expect(route.label.y).toBeCloseTo(36);
  expect(route.label.x).toBeGreaterThan(180);
  expect(route.label.x).toBeLessThan(200);
});

test("labels stay inside the area the cards span so the canvas edge never cuts them", () => {
  const cards = {
    a: { x: 0, y: 0, width: 180, height: 72 },
    b: { x: 0, y: 140, width: 180, height: 72 },
  };
  const routes = routeAll(cards, [
    { id: "e", source: "a", target: "b", label: "mentions" },
  ]);
  const at = routes["e"]!.label;
  const size = labelSize("mentions");
  expect(at.x - size.width / 2).toBeGreaterThanOrEqual(-40);
  expect(at.x + size.width / 2).toBeLessThanOrEqual(220);
});
