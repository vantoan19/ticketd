// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { changeTheme } from "@/lib/preferences";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";

// Changing the theme crossfades the whole window (DESIGN.md section 12); with
// reduced motion, a held key, or no View Transitions API, it is one frame.

type Document_ = { startViewTransition?: unknown };
const doc = document as unknown as Document_;

let restoreTokens: () => void;
let start: ReturnType<typeof vi.fn>;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  document.documentElement.dataset.theme = "light";
  start = vi.fn((update: () => void) => update());
  doc.startViewTransition = start;
});
afterEach(() => {
  restoreTokens();
  delete doc.startViewTransition;
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove("dark");
});

test("a theme change runs inside a view transition, which is what crossfades", () => {
  changeTheme("dark");
  expect(start).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("choosing the theme already shown does not fade", () => {
  changeTheme("light");
  expect(start).not.toHaveBeenCalled();
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key or rapid clicks", instantTokens],
])("with %s the theme changes in one frame", (_name, tokens) => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
  changeTheme("dark");
  expect(start).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("a webview without view transitions still changes theme", () => {
  delete doc.startViewTransition;
  changeTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});
