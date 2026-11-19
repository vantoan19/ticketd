// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { arrival } from "@/components/ui/row-motion";
import { applyTokens, coldTokenCache, rootTokens } from "@/test/motion-tokens";
import { columnArrivals } from "./column-motion";

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  restoreTokens();
  vi.restoreAllMocks();
});

it("the columns' entrance reads the tokens once, however many columns", () => {
  // Each count starts from a cold token cache.
  const reads = () => {
    coldTokenCache();
    const spy = vi.spyOn(window, "getComputedStyle");
    return { spy, count: () => spy.mock.calls.length };
  };
  const six = reads();
  columnArrivals(6);
  const sixReads = six.count();
  six.spy.mockRestore();
  const one = reads();
  columnArrivals(1);
  expect(one.count()).toBe(sixReads);
  expect(sixReads).toBeGreaterThan(0);
});

it("each column waits one stagger step behind the one before, as arrival does", () => {
  const arrivals = columnArrivals(10);
  for (const [position, { animate }] of arrivals.entries()) {
    const expected = arrival(position).animate.transition;
    expect(animate.transition.default.delay).toBe(expected.default.delay);
    expect(animate.transition.y.delay).toBe(expected.y.delay);
  }
});
