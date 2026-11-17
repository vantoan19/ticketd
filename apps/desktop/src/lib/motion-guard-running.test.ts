// @vitest-environment jsdom
import { animate, MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { frames } from "@/test/motion-clock";
import { installMotionGuard } from "./motion-guard";

// When the guard engages, motion that is already running finishes at once
// (DESIGN.md section 12): CSS transitions and animations, and the motion
// library's own. A new change still interrupts a running one.

let stop: () => void;
beforeEach(() => {
  stop = installMotionGuard();
});
afterEach(() => {
  stop();
  delete (document as { getAnimations?: unknown }).getAnimations;
  MotionGlobalConfig.skipAnimations = false;
  vi.restoreAllMocks();
});

const hold = () =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "j", repeat: true }),
  );

/** A CSS animation or transition the browser is running. */
function running(endTime: number) {
  return {
    finish: vi.fn(),
    effect: { getComputedTiming: () => ({ endTime }) },
  };
}
function browserRuns(...animations: ReturnType<typeof running>[]) {
  (document as { getAnimations?: unknown }).getAnimations = () => animations;
}

it("finishes the CSS transitions and animations that are running", () => {
  const collapse = running(440);
  const arriving = running(240);
  browserRuns(collapse, arriving);
  hold();
  expect(collapse.finish).toHaveBeenCalledTimes(1);
  expect(arriving.finish).toHaveBeenCalledTimes(1);
});

it("leaves a loop alone, since it has no end to finish at", () => {
  const sheen = running(Number.POSITIVE_INFINITY);
  browserRuns(sheen);
  hold();
  expect(sheen.finish).not.toHaveBeenCalled();
});

it("only the press that engages the guard finishes motion; the next change plays out", () => {
  const first = running(440);
  browserRuns(first);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
  expect(first.finish).not.toHaveBeenCalled();
  hold();
  expect(first.finish).toHaveBeenCalledTimes(1);
  // The repeats that follow find the window already instant.
  hold();
  hold();
  expect(first.finish).toHaveBeenCalledTimes(1);
});

it("finishes a motion-library animation that is running", async () => {
  const onUpdate = vi.fn();
  const onComplete = vi.fn();
  animate(0, 100, { duration: 60, onUpdate, onComplete });
  await frames(2);
  expect(onComplete).not.toHaveBeenCalled();

  hold();
  await frames(3);
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onUpdate).toHaveBeenLastCalledWith(100);
});
