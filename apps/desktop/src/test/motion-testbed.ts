import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { freezeMotionClock } from "@/test/motion-clock";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";

/** The exit time token (`--dur-exit`), in milliseconds. */
export const EXIT_MS = 150;
/** Longer than any entrance, spring included: time is the test's, so it is free. */
export const SETTLED_MS = 2000;

/**
 * The setup every motion test needs, called once at the top of a test file: the
 * real tokens on the document and a motion clock the test owns (see
 * test/motion-clock). A motion moves only when `advance` says so, so a loaded
 * machine cannot change an outcome. An instant path (reduced motion, a held key)
 * is done after the next frame with time standing still.
 */
export function motionTestbed() {
  let restoreTokens: () => void;
  let clock: ReturnType<typeof freezeMotionClock>;
  beforeEach(() => {
    restoreTokens = applyTokens(rootTokens);
    clock = freezeMotionClock();
  });
  afterEach(() => {
    cleanup();
    clock.restore();
    restoreTokens();
  });
  return {
    advance: (ms: number) => clock.advance(ms),
    /** Back to the real clock, for the rare test that waits on a state. */
    realTime: () => clock.restore(),
    /** The tokens as `prefers-reduced-motion` sets them. */
    reduceMotion() {
      restoreTokens();
      restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
    },
  };
}

/** A key held down: the input guard zeroes motion until it is released. */
export function holdKey() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", repeat: true }),
    );
  });
}
