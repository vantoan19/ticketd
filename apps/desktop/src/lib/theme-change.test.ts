// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { changeTheme } from "@/lib/preferences";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";

// Changing the theme crossfades the whole window (DESIGN.md section 12) with
// a transition on <html>, not the View Transitions API; with reduced motion
// or a held key it is one frame.

const root = document.documentElement;
const fading = () => root.hasAttribute("data-theme-fading");

let restoreTokens: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  restoreTokens = applyTokens(rootTokens);
  root.dataset.theme = "light";
});
afterEach(() => {
  vi.useRealTimers();
  restoreTokens();
  delete root.dataset.theme;
  root.removeAttribute("data-theme-fading");
  root.classList.remove("dark");
});

test("a theme change fades while --dur-theme runs, then settles", () => {
  changeTheme("dark");
  expect(root.dataset.theme).toBe("dark");
  expect(root.classList.contains("dark")).toBe(true);
  expect(fading()).toBe(true);

  vi.advanceTimersByTime(279);
  expect(fading()).toBe(true);
  vi.advanceTimersByTime(1);
  expect(fading()).toBe(false);
});

test("the fade lasts the token's length whatever unit it is written in", () => {
  root.style.setProperty("--dur-theme", "0.28s");
  changeTheme("dark");
  vi.advanceTimersByTime(279);
  expect(fading()).toBe(true);
  vi.advanceTimersByTime(1);
  expect(fading()).toBe(false);
});

test("a second change restarts the fade instead of ending it early", () => {
  changeTheme("dark");
  vi.advanceTimersByTime(200);
  changeTheme("light");
  vi.advanceTimersByTime(200);
  expect(fading()).toBe(true);
  vi.advanceTimersByTime(80);
  expect(fading()).toBe(false);
});

test("choosing the theme already shown does not fade", () => {
  changeTheme("light");
  expect(fading()).toBe(false);
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key or rapid clicks", instantTokens],
])("with %s the theme changes in one frame", (_name, tokens) => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
  changeTheme("dark");
  expect(fading()).toBe(false);
  expect(root.dataset.theme).toBe("dark");
});

test("the fade is plain CSS transitions, not view transitions", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  expect(css).not.toContain("view-transition");
  const rule = css.match(
    /:root\[data-theme-fading\]\s*\*[^{]*\{([^}]*)\}/,
  )?.[1];
  expect(rule).toContain("var(--dur-theme)");
  expect(rule).toContain("var(--ease-in-out)");
  for (const property of [
    "background-color",
    "color",
    "border-color",
    "fill",
    "stroke",
    "box-shadow",
  ]) {
    expect(rule).toContain(property);
  }
});

test("choice tiles fade their hairlines with the theme; only a chosen tile's ring is instant", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  const instant = [
    ...css.matchAll(
      /(:root\[data-theme-fading\][^{}]*\[data-slot\^?="choice-tile[^{}]*)\{([^}]*)\}/g,
    ),
  ].filter(([, , body]) => !body?.includes("var(--dur-theme)"));
  expect(instant.length).toBeGreaterThan(0);
  for (const [selector, , body] of instant) {
    expect(selector).toContain('[data-state="checked"]');
    expect(body).not.toContain("box-shadow");
  }
});
