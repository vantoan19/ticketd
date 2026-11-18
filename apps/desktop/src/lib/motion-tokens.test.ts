// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";
import {
  blur,
  enterTransition,
  exitTransition,
  rise,
  spring,
  staggerDelay,
} from "./motion-tokens";

// JS reads motion from the CSS tokens, at the moment it starts the motion, so
// reduced motion and the input guard reach it through the same variables.

let restore: () => void;
beforeEach(() => {
  restore = applyTokens(rootTokens);
});
afterEach(() => restore());

it("a spring takes its settle time and curve from the tokens", () => {
  const { duration, ease } = spring("smooth");
  expect(duration).toBeCloseTo(0.44);
  expect(typeof ease).toBe("function");
  if (typeof ease !== "function") return;
  expect(ease(0)).toBe(0);
  expect(ease(1)).toBe(1);
  // Most of the distance is covered early and it never passes the target.
  expect(ease(0.5)).toBeGreaterThan(0.8);
  expect(ease(0.5)).toBeLessThanOrEqual(1);
  expect(ease(0.25)).toBeLessThan(ease(0.5));
});

it("enter and exit take duration and easing from the tokens", () => {
  expect(enterTransition()).toEqual({
    duration: 0.24,
    ease: [0.16, 1, 0.3, 1],
  });
  expect(exitTransition()).toEqual({
    duration: 0.15,
    ease: [0.4, 0, 1, 1],
  });
});

it("offsets, blur and stagger come from the tokens", () => {
  expect(rise("row")).toBe(6);
  expect(rise("overlay")).toBe(8);
  expect(blur("in")).toBe(4);
  expect(blur("out")).toBe(2);
  expect(staggerDelay(3)).toBeCloseTo(0.072);
  // A cascade is at most eight steps long.
  expect(staggerDelay(40)).toBeCloseTo(0.168);
});

it("the length of a cascade is the --stagger-steps token, which the CSS entrances read too", () => {
  restore();
  restore = applyTokens({ ...rootTokens, "--stagger-steps": "3" });
  expect(staggerDelay(40)).toBeCloseTo(0.072);
});

it("reduced motion makes all of it instant", () => {
  restore();
  restore = applyTokens({ ...rootTokens, ...reducedTokens });
  expect(spring("travel").duration).toBe(0);
  expect(enterTransition().duration).toBe(0);
  expect(exitTransition().duration).toBe(0);
  expect(rise("overlay")).toBe(0);
  expect(blur("in")).toBe(0);
  expect(staggerDelay(5)).toBe(0);
});

it("with no tokens loaded motion is instant, not guessed", () => {
  restore();
  restore = () => {};
  expect(spring("glide").duration).toBe(0);
  expect(rise("row")).toBe(0);
});
