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

// The inspector hands over whatever the library has: a record can lack its
// animation, or hold one whose `state` or `complete` throws. One bad record
// never stops the rest from finishing, and never leaves the window instant.

const inspect = (record: unknown) =>
  (
    globalThis as unknown as { __MOTION_INSPECT__: (record: unknown) => void }
  ).__MOTION_INSPECT__(record);
const instant = () => document.documentElement.dataset.motion === "instant";

/** A library animation that is running, with the record the library hands over. */
function libraryRuns() {
  const complete = vi.fn();
  inspect({ animation: { state: "running", complete } });
  return complete;
}

it("skips a record with no animation, and finishes the rest", () => {
  const before = libraryRuns();
  inspect({});
  inspect({ animation: undefined });
  const after = libraryRuns();
  expect(hold).not.toThrow();
  expect(before).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
});

it("skips an animation with no state or whose state throws", () => {
  inspect({ animation: { complete: vi.fn() } });
  inspect({
    animation: {
      get state(): string {
        throw new TypeError("no state");
      },
      complete: vi.fn(),
    },
  });
  const ok = libraryRuns();
  expect(hold).not.toThrow();
  expect(ok).toHaveBeenCalledTimes(1);
});

it("a complete that throws does not stop the rest, the browser, or the release", () => {
  inspect({
    animation: {
      state: "running",
      complete() {
        throw new Error("gone");
      },
    },
  });
  const ok = libraryRuns();
  const css = running(300);
  browserRuns(css);
  expect(hold).not.toThrow();
  expect(ok).toHaveBeenCalledTimes(1);
  expect(css.finish).toHaveBeenCalledTimes(1);
});

it("a throw never leaves the window instant or the finished set in place", () => {
  vi.useFakeTimers();
  try {
    inspect({
      animation: {
        state: "running",
        complete() {
          throw new Error("gone");
        },
      },
    });
    hold();
    expect(instant()).toBe(true);
    vi.advanceTimersByTime(400);
    expect(instant()).toBe(false);
    expect(MotionGlobalConfig.skipAnimations).toBe(false);
    // The record that threw was dropped: the next engagement runs clean.
    const next = libraryRuns();
    hold();
    expect(next).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("a browser animation that throws does not stop the others", () => {
  const bad = running(300);
  bad.finish.mockImplementation(() => {
    throw new Error("detached");
  });
  const good = running(300);
  browserRuns(bad, good);
  expect(hold).not.toThrow();
  expect(good.finish).toHaveBeenCalledTimes(1);
});
