import { act } from "@testing-library/react";
import { frameData, MotionGlobalConfig } from "motion/react";

// A clock the test owns, for the motion library. In manual timing the library
// reads `frameData.timestamp` instead of the wall clock, so a motion moves only
// when `advance` says so and a loaded machine cannot change the outcome. Frames
// still come from the real requestAnimationFrame; `frames` waits for them by
// count, never by duration.

/** Wait for `count` animation frames, inside act so React flushes. */
export async function frames(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
  }
}

/** Freeze motion time. Returns `advance(ms)` and the function that restores it. */
export function freezeMotionClock(): {
  advance: (ms: number) => Promise<void>;
  restore: () => void;
} {
  const was = MotionGlobalConfig.useManualTiming ?? false;
  MotionGlobalConfig.useManualTiming = true;
  return {
    advance: async (ms) => {
      frameData.timestamp += ms;
      await frames();
    },
    restore: () => {
      MotionGlobalConfig.useManualTiming = was;
    },
  };
}
