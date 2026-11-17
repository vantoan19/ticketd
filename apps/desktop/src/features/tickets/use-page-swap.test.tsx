// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { usePageSwap } from "./use-page-swap";

// J and K between tickets: the open document fades out, the next one fades up
// after it. The swap is told apart from opening and closing.

let restoreTokens: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.useRealTimers();
});

function selection(first: string | null) {
  return renderHook(({ selected }) => usePageSwap(selected), {
    initialProps: { selected: first },
  });
}

test("moving to another ticket keeps the old document for one exit", () => {
  const view = selection("T-KQ1");
  expect(view.result.current).toEqual({ swapped: false, leaving: null });
  view.rerender({ selected: "T-KQ2" });
  expect(view.result.current).toEqual({ swapped: true, leaving: "T-KQ1" });
  act(() => void vi.advanceTimersByTime(150));
  // The next document keeps its swap arrival; only the old one is gone.
  expect(view.result.current).toEqual({ swapped: true, leaving: null });
});

test("a new swap interrupts the one running", () => {
  const view = selection("T-KQ1");
  view.rerender({ selected: "T-KQ2" });
  act(() => void vi.advanceTimersByTime(100));
  view.rerender({ selected: "T-KQ3" });
  expect(view.result.current.leaving).toBe("T-KQ2");
  act(() => void vi.advanceTimersByTime(100));
  expect(view.result.current.leaving).toBe("T-KQ2");
  act(() => void vi.advanceTimersByTime(50));
  expect(view.result.current.leaving).toBeNull();
});

test("opening from nothing and closing are not swaps", () => {
  const view = selection(null);
  view.rerender({ selected: "T-KQ1" });
  expect(view.result.current).toEqual({ swapped: false, leaving: null });
  view.rerender({ selected: null });
  expect(view.result.current).toEqual({ swapped: false, leaving: null });
});

test("reduced motion and a held J or K swap at once", () => {
  for (const tokens of [reducedTokens, instantTokens]) {
    restoreTokens();
    restoreTokens = applyTokens({ ...rootTokens, ...tokens });
    const view = selection("T-KQ1");
    view.rerender({ selected: "T-KQ2" });
    expect(view.result.current.leaving).toBeNull();
    view.unmount();
  }
});
