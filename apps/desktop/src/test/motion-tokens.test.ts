import { expect, it } from "vitest";
import { instantTokens, reducedTokens, rootTokens } from "./motion-tokens";

// DESIGN.md section 12: the Refined motion tokens and the rule that reduced
// motion (and a held key) makes every one of them instant.

const MOTION = /^--(dur-|stagger$|motion-(blur|rise)|spring-[a-z]+-t$)/;
const motionTokens = Object.keys(rootTokens).filter((n) => MOTION.test(n));

it("defines the Refined tokens", () => {
  expect(rootTokens).toMatchObject({
    "--spring-glide-t": "366ms",
    "--spring-smooth-t": "440ms",
    "--spring-travel-t": "562ms",
    "--dur-enter": "240ms",
    "--dur-exit": "150ms",
    "--motion-blur-in": "4px",
    "--motion-blur-out": "2px",
    "--motion-rise": "6px",
    "--motion-rise-overlay": "8px",
    "--stagger": "24ms",
    "--dur-sheen": "1.6s",
    "--dur-theme": "280ms",
  });
});

it.each(["glide", "smooth", "travel"])(
  "the %s spring settles without overshoot",
  (name) => {
    const easing = rootTokens[`--spring-${name}`] ?? "";
    expect(easing).toMatch(/^linear\(/);
    const stops = easing.slice(7, -1).split(",").map(Number);
    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1);
    // Critically damped: never past the target, never turning back.
    expect(stops.every((s, i) => i === 0 || s >= (stops[i - 1] ?? 0))).toBe(
      true,
    );
    expect(Math.max(...stops)).toBe(1);
  },
);

it("reduced motion zeroes every duration, offset and blur token", () => {
  expect(motionTokens.filter((n) => reducedTokens[n] === undefined)).toEqual(
    [],
  );
  for (const name of motionTokens)
    expect(reducedTokens[name], name).toMatch(/^0(ms|px)?$/);
});

it("a held key zeroes the same tokens, except those that are not motion", () => {
  // Skeletons and spinners keep their timing: a fast read must not flash one.
  const kept = ["--dur-loading-delay", "--dur-spin"];
  expect(Object.keys(instantTokens).sort()).toEqual(
    motionTokens.filter((n) => !kept.includes(n)).sort(),
  );
  for (const name of Object.keys(instantTokens))
    expect(instantTokens[name], name).toMatch(/^0(ms|px)?$/);
});
