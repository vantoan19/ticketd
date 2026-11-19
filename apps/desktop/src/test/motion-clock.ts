import { act, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
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

/**
 * Freeze motion time. Returns `advance(ms)`, `restInput()` and the function that
 * restores the clock.
 */
export function freezeMotionClock(): {
  advance: (ms: number) => Promise<void>;
  restInput: () => Promise<void>;
  restore: () => void;
} {
  const was = MotionGlobalConfig.useManualTiming ?? false;
  MotionGlobalConfig.useManualTiming = true;
  let skew = 0;
  let performanceNow: { mockRestore(): void } | undefined;
  return {
    advance: async (ms) => {
      frameData.timestamp += ms;
      await frames();
    },
    // The input guard (lib/motion-guard) runs on the real clock, not on this
    // one: a click within 350ms of the one before it is rapid, and a rapid click
    // holds every motion instant for 300ms. A test that clicks twice (open a
    // menu, choose in it) and then starts the motion it checks would pass or fail
    // by how fast the machine is. This ends both windows: the earlier clicks
    // are far behind the next one, and the hold is released.
    restInput: async () => {
      if (!performanceNow) {
        const real = performance.now.bind(performance);
        performanceNow = vi
          .spyOn(performance, "now")
          .mockImplementation(() => real() + skew);
      }
      skew += 1000;
      await waitFor(() =>
        expect(document.documentElement.dataset.motion).toBeUndefined(),
      );
    },
    restore: () => {
      MotionGlobalConfig.useManualTiming = was;
      performanceNow?.mockRestore();
      performanceNow = undefined;
      skew = 0;
    },
  };
}
