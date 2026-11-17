import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// The CSS primitives name no time of their own: every motion token they use is
// one reduced motion zeroes, and one a held key zeroes unless it is kept.
const KEPT = ["--dur-loading-delay", "--dur-spin"];
const primitiveCss = ["components/ui/motion.css", "components/ui/patterns.css"];

function stylesheet(file: string): string {
  return readFileSync(join(__dirname, "..", file), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
}

it.each(primitiveCss)("%s takes its timing only from the tokens", (file) => {
  const timing = [
    ...stylesheet(file).matchAll(/(?:animation|transition)[\w-]*:\s*([^;]+);/g),
  ]
    .map((m) => m[1] ?? "")
    .join(" ");
  expect(timing, "a literal time").not.toMatch(/(?<![\w-])[1-9][\d.]*m?s\b/);
  for (const [, name = ""] of timing.matchAll(/var\((--[\w-]+)/g)) {
    if (!MOTION.test(name)) continue;
    expect(reducedTokens[name], `${name} under reduced motion`).toBeDefined();
    if (!KEPT.includes(name))
      expect(instantTokens[name], `${name} while a key repeats`).toBeDefined();
  }
});

it("a skeleton shows a sheen on the sheen token", () => {
  const skeleton =
    /\.ui-skeleton\s*\{([^}]*)\}/.exec(
      stylesheet("components/ui/patterns.css"),
    )?.[1] ?? "";
  expect(skeleton).toContain("var(--dur-sheen)");
});
