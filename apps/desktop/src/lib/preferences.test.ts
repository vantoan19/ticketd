// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  applyTheme,
  loadPreferences,
  resolveTheme,
  setPreference,
} from "@/lib/preferences";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test("System follows the operating system while Light and Dark override it", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("light", true)).toBe("light");
});

test("choices persist and unknown stored values fall back to defaults", () => {
  expect(loadPreferences()).toEqual({ theme: "system", openTickets: "split" });
  expect(setPreference("theme", "dark")).toBe(true);
  expect(setPreference("openTickets", "expanded")).toBe(true);
  expect(loadPreferences()).toEqual({ theme: "dark", openTickets: "expanded" });
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ theme: "neon", openTickets: "expanded" }),
  );
  expect(loadPreferences()).toEqual({
    theme: "system",
    openTickets: "expanded",
  });
});

test("a choice that cannot be stored is reported", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(setPreference("theme", "light")).toBe(false);
});

test("applying a theme marks the document root", () => {
  applyTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  applyTheme("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});
