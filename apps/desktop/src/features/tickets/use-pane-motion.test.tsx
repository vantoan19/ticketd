// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { useHeld, usePaneMotion, type PaneMode } from "./use-pane-motion";

// How the list and the document move when the ticket opens, closes, goes full
// width and comes back (DESIGN.md section 5). Timing comes from the tokens, so
// the tests apply the real ones.

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

function setTokens(tokens: Record<string, string>) {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
}

function pane(first: PaneMode) {
  return renderHook(({ mode }) => usePaneMotion(mode), {
    initialProps: { mode: first },
  });
}

test("opening a ticket glides the document in and nothing leaves", () => {
  const view = pane("closed");
  expect(view.result.current).toEqual({ arrival: null, leaving: null });
  view.rerender({ mode: "split" });
  expect(view.result.current).toEqual({ arrival: "open", leaving: null });
});

test("closing keeps the document on screen for one exit, then lets it go", () => {
  const view = pane("split");
  view.rerender({ mode: "closed" });
  expect(view.result.current.leaving).toEqual({
    pane: "detail",
    from: "split",
  });
  act(() => void vi.advanceTimersByTime(149));
  expect(view.result.current.leaving).not.toBeNull();
  act(() => void vi.advanceTimersByTime(1));
  expect(view.result.current.leaving).toBeNull();
});

test("going full width lets the list leave while the document glides in", () => {
  const view = pane("split");
  view.rerender({ mode: "expanded" });
  expect(view.result.current).toEqual({
    arrival: "expand",
    leaving: { pane: "list", from: "split" },
  });
  // The list is gone after its exit; the document's glide runs on.
  act(() => void vi.advanceTimersByTime(150));
  expect(view.result.current.leaving).toBeNull();
  expect(view.result.current.arrival).toBe("expand");
  // The glide is over after the smooth spring (440ms), so coming back to the
  // Tickets view later does not play it again.
  act(() => void vi.advanceTimersByTime(290));
  expect(view.result.current.arrival).toBeNull();
});

test("coming back from full width brings the list in from the left", () => {
  const view = pane("expanded");
  view.rerender({ mode: "split" });
  expect(view.result.current).toEqual({ arrival: "return", leaving: null });
});

test("closing from full width leaves the whole document", () => {
  const view = pane("expanded");
  view.rerender({ mode: "closed" });
  expect(view.result.current.leaving).toEqual({
    pane: "detail",
    from: "expanded",
  });
});

test("opening while the last ticket is still leaving cancels its exit", () => {
  const view = pane("split");
  view.rerender({ mode: "closed" });
  view.rerender({ mode: "split" });
  expect(view.result.current).toEqual({ arrival: "open", leaving: null });
});

test("reduced motion and a held key make every change instant", () => {
  for (const tokens of [reducedTokens, instantTokens]) {
    setTokens(tokens);
    const view = pane("split");
    view.rerender({ mode: "closed" });
    expect(view.result.current).toEqual({ arrival: null, leaving: null });
    view.rerender({ mode: "split" });
    view.rerender({ mode: "expanded" });
    expect(view.result.current).toEqual({ arrival: null, leaving: null });
    view.unmount();
  }
});

test("a pane held while it leaves keeps what it showed", () => {
  const view = renderHook(
    ({ reference, holding }) => useHeld({ reference }, holding),
    { initialProps: { reference: "T-KQ1" as string | null, holding: false } },
  );
  expect(view.result.current.reference).toBe("T-KQ1");
  view.rerender({ reference: null, holding: true });
  expect(view.result.current.reference).toBe("T-KQ1");
  view.rerender({ reference: null, holding: false });
  expect(view.result.current.reference).toBeNull();
});
