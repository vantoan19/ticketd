// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { ArrivingGroup } from "./ArrivingGroup";

// A group that arrives after the rest of the sidebar opens, rather than
// popping in and pushing the rows below it down (DESIGN.md section 12).

let restoreTokens: () => void;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.useRealTimers();
});

const group = (present: boolean) => (
  <ArrivingGroup present={present}>
    <p>Projects</p>
  </ArrivingGroup>
);
const slot = () => document.querySelector('[data-slot="expand"]');
const settle = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

it("a group that is there at the start is simply there", () => {
  render(group(true));
  expect(slot()?.getAttribute("data-open")).toBe("true");
});

it("renders nothing while there is no group", () => {
  render(group(false));
  expect(slot()).toBeNull();
});

it("a group that arrives late mounts closed and opens a frame later", () => {
  const { rerender } = render(group(false));
  rerender(group(true));
  expect(slot()?.getAttribute("data-open")).toBe("false");
  settle(20);
  expect(slot()?.getAttribute("data-open")).toBe("true");
});

it("a group that leaves closes first and is removed once the spring is done", () => {
  const { rerender } = render(group(true));
  rerender(group(false));
  expect(slot()?.getAttribute("data-open")).toBe("false");
  settle(440);
  expect(slot()).toBeNull();
});
