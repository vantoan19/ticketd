// @vitest-environment jsdom
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMotionGuard } from "./motion-guard";

// A held key and rapid clicks land instantly (DESIGN.md section 12).

let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  stop = installMotionGuard();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

const instant = () => document.documentElement.dataset.motion === "instant";

function press(repeat: boolean) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", repeat }));
}
const click = () => window.dispatchEvent(new MouseEvent("click"));

it("a single key press or click keeps its motion", () => {
  press(false);
  click();
  expect(instant()).toBe(false);
  expect(MotionGlobalConfig.skipAnimations).toBeFalsy();
});

it("key repeat makes motion instant, then restores it", () => {
  press(false);
  press(true);
  expect(instant()).toBe(true);
  expect(MotionGlobalConfig.skipAnimations).toBe(true);
  // Still held: each repeat extends the window.
  vi.advanceTimersByTime(200);
  press(true);
  vi.advanceTimersByTime(200);
  expect(instant()).toBe(true);
  vi.advanceTimersByTime(200);
  expect(instant()).toBe(false);
  expect(MotionGlobalConfig.skipAnimations).toBe(false);
});

it("a second click straight after the first is instant", () => {
  click();
  vi.advanceTimersByTime(200);
  click();
  expect(instant()).toBe(true);
});

it("clicks a second apart each keep their motion", () => {
  click();
  vi.advanceTimersByTime(1000);
  click();
  expect(instant()).toBe(false);
});

it("uninstalling restores motion", () => {
  press(true);
  stop();
  expect(instant()).toBe(false);
  expect(MotionGlobalConfig.skipAnimations).toBe(false);
  press(true);
  expect(instant()).toBe(false);
});
