import type { Easing } from "motion/react";

// Motion timing lives in the CSS tokens of styles.css. This is the one place JS
// reads them, so the motion library never holds a copy and reduced motion, the
// input guard (lib/motion-guard) and a theme preview all reach it through the
// same variables. Values are read when motion starts, so they are current.
//
// A token that is missing (a test without the stylesheet) reads as zero: no
// motion, never a guessed duration.

/** The longest cascade: items after the eighth start together with it. */
const STAGGER_STEPS = 7;

function token(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function number(name: string): number {
  return Number.parseFloat(token(name)) || 0;
}

/** A time token (`240ms`, `1.6s`) in seconds, which is what the library takes. */
function seconds(name: string): number {
  const value = token(name);
  return value.endsWith("ms") ? number(name) / 1000 : number(name);
}

/** `cubic-bezier(a, b, c, d)` as the library's control points. */
function bezier(name: string): Easing {
  const points = /^cubic-bezier\(([^)]*)\)$/.exec(token(name))?.[1];
  const [a, b, c, d] = (points ?? "").split(",").map(Number);
  return a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
    ? "linear"
    : [a, b, c, d];
}

/**
 * A `linear(...)` curve as a function. The springs are sampled evenly with
 * plain numbers and no stop positions, which is all this reads.
 */
function sampled(name: string): Easing {
  const stops = /^linear\(([^)]*)\)$/
    .exec(token(name))?.[1]
    ?.split(",")
    .map(Number);
  if (!stops || stops.length < 2 || stops.some(Number.isNaN)) return "linear";
  const last = stops.length - 1;
  return (t) => {
    const at = Math.min(Math.max(t, 0), 1) * last;
    const i = Math.min(Math.floor(at), last - 1);
    const from = stops[i] ?? 0;
    return from + ((stops[i + 1] ?? 1) - from) * (at - i);
  };
}

export type SpringName = "glide" | "smooth" | "travel";

/** A no-bounce spring: settle time and curve, for `transition`. */
export function spring(name: SpringName): { duration: number; ease: Easing } {
  return {
    duration: seconds(`--spring-${name}-t`),
    ease: sampled(`--spring-${name}`),
  };
}

/** Opacity and blur of an entrance. */
export function enterTransition(): { duration: number; ease: Easing } {
  return { duration: seconds("--dur-enter"), ease: bezier("--ease-out") };
}

/** An exit, faster than the entrance. */
export function exitTransition(): { duration: number; ease: Easing } {
  return { duration: seconds("--dur-exit"), ease: bezier("--ease-in") };
}

/** How far, in px, an entrance starts below its place. */
export function rise(kind: "row" | "overlay"): number {
  return number(kind === "row" ? "--motion-rise" : "--motion-rise-overlay");
}

/** The blur, in px, an entrance starts from or an exit ends at. */
export function blur(direction: "in" | "out"): number {
  return number(`--motion-blur-${direction}`);
}

/** Seconds item `index` of a cascade waits behind the first. */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(index, 0), STAGGER_STEPS) * seconds("--stagger");
}

/** Seconds the whole window takes to crossfade to another theme. */
export function themeFade(): number {
  return seconds("--dur-theme");
}
