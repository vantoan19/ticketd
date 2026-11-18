import type { Easing } from "motion/react";

// Motion timing lives in the CSS tokens of styles.css. This is the one place JS
// reads them, so the motion library never holds a copy and reduced motion, the
// input guard (lib/motion-guard) and a theme preview all reach it through the
// same variables. Values are read when motion starts, so they are current.
//
// A token that is missing (a test without the stylesheet) reads as zero: no
// motion, never a guessed duration.

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
function sampled(curve: string): Easing {
  const stops = /^linear\(([^)]*)\)$/.exec(curve)?.[1]?.split(",").map(Number);
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

type Spring = { duration: number; ease: Easing };
const springs = new Map<SpringName, { curve: string; transition: Spring }>();

/** A no-bounce spring: settle time and curve, for `transition`. */
export function spring(name: SpringName): Spring {
  const duration = seconds(`--spring-${name}-t`);
  const curve = token(`--spring-${name}`);
  const cached = springs.get(name);
  // An unchanged spring does not invalidate the board's memoized cards.
  if (cached?.curve === curve && cached.transition.duration === duration)
    return cached.transition;
  const transition = { duration, ease: sampled(curve) };
  springs.set(name, { curve, transition });
  return transition;
}

/** Opacity and blur of an entrance. */
export function enterTransition(): { duration: number; ease: Easing } {
  return { duration: seconds("--dur-enter"), ease: bezier("--ease-out") };
}

/** An exit, faster than the entrance. */
export function exitTransition(): { duration: number; ease: Easing } {
  return { duration: seconds("--dur-exit"), ease: bezier("--ease-in") };
}

/** How long, in seconds, an exit takes: what an arrival waits for. */
export function exitDuration(): number {
  return exitTransition().duration;
}

/**
 * An easing or spring token in CSS's own spelling, which the Web Animations
 * API takes as it stands. A missing token reads as `linear`.
 */
export function cssEasing(
  name: "--ease-out" | "--ease-in" | "--spring-smooth",
): string {
  return token(name) || "linear";
}

/** How far, in px, an entrance starts below its place. */
export function rise(kind: "row" | "overlay"): number {
  return number(kind === "row" ? "--motion-rise" : "--motion-rise-overlay");
}

/** The blur, in px, an entrance starts from or an exit ends at. */
export function blur(direction: "in" | "out"): number {
  return number(`--motion-blur-${direction}`);
}

/**
 * Seconds item `index` of a cascade waits behind the first. A cascade stops
 * after `--stagger-steps` steps (eight items): later items start with the last.
 * The CSS entrances read the same token.
 */
export function staggerDelay(index: number): number {
  const last = number("--stagger-steps");
  return Math.min(Math.max(index, 0), last) * seconds("--stagger");
}

/** Seconds a read is given before any placeholder shows, so a fast one never flashes. */
export function loadingDelay(): number {
  return seconds("--dur-loading-delay");
}

/** Seconds the whole window takes to crossfade to another theme. */
export function themeFade(): number {
  return seconds("--dur-theme");
}

/** Seconds one change leads another: the dot that arrives before its word. */
export function lead(): number {
  return seconds("--dur-1");
}
