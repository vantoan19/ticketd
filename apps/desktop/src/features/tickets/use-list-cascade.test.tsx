// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { useListCascade } from "./use-list-cascade";

// The list's cascade is one-shot (DESIGN.md section 12): it is asked for when
// the list replaces the Board, or replaces placeholders that were shown, and
// cleared once taken. Placeholders show only after the loading delay (300ms).

type Props = { layout: "list" | "board"; waiting: boolean };
const start = (props: Props) =>
  renderHook((now: Props) => useListCascade(now.layout, now.waiting), {
    initialProps: props,
  });

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

test("the list on screen from the start has no cascade", () => {
  const { result } = start({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(false);
});

test("back from the Board the rows cascade, once", () => {
  const { result, rerender } = start({ layout: "board", waiting: false });
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(true);
  act(() => result.current.done());
  expect(result.current.cascade).toBe(false);
  // A later change in the list does not bring it back.
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(false);
});

test("going to the Board asks for nothing", () => {
  const { result, rerender } = start({ layout: "list", waiting: false });
  rerender({ layout: "board", waiting: false });
  expect(result.current.cascade).toBe(false);
});

test("rows that replace placeholders that were shown cascade, once", () => {
  const { result, rerender } = start({ layout: "list", waiting: true });
  expect(result.current.cascade).toBe(false);
  // Past the loading delay the placeholders are on screen.
  act(() => vi.advanceTimersByTime(300));
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(true);
  act(() => result.current.done());
  expect(result.current.cascade).toBe(false);
});

test("a read that ended inside the loading delay showed nothing, so its rows do not cascade", () => {
  const { result, rerender } = start({ layout: "list", waiting: true });
  act(() => vi.advanceTimersByTime(290));
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(false);
  // Nor does the timer, once the wait is over, show placeholders afterwards.
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.cascade).toBe(false);
});

test("each wait is timed on its own: a short one after a long one does not cascade", () => {
  const { result, rerender } = start({ layout: "list", waiting: true });
  act(() => vi.advanceTimersByTime(400));
  rerender({ layout: "list", waiting: false });
  act(() => result.current.done());
  rerender({ layout: "list", waiting: true });
  act(() => vi.advanceTimersByTime(100));
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(false);
});

test("the delay is the loading-delay token, so it follows reduced motion", () => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, "--dur-loading-delay": "0ms" });
  const { result, rerender } = start({ layout: "list", waiting: true });
  act(() => vi.advanceTimersByTime(0));
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(true);
});

test("placeholders appearing later ask for nothing", () => {
  const { result, rerender } = start({ layout: "list", waiting: false });
  rerender({ layout: "list", waiting: true });
  expect(result.current.cascade).toBe(false);
});
