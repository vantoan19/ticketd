import { expect, test } from "vitest";
import {
  borderPoint,
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
