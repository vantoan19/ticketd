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
  expect(loadPreferences()).toEqual({
    theme: "system",
    openTickets: "split",
    openDocuments: "split",
    ticketLayout: "list",
    planListDone: {},
    ticketRows: "simple",
    sidebarCollapsed: false,
    followCreated: true,
    chat: false,
    notifyChats: true,
    attachmentDetails: false,
    attachmentWrap: true,
    documentsView: "current",
    documentsSort: "opened",
    documentGroups: {},
    setupHidden: false,
    setupFinished: false,
    settingsPage: "appearance",
  });
  expect(setPreference("theme", "dark")).toBe(true);
  expect(setPreference("openTickets", "expanded")).toBe(true);
  expect(loadPreferences()).toMatchObject({
    theme: "dark",
    openTickets: "expanded",
  });
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ theme: "neon", openTickets: "expanded" }),
  );
  expect(loadPreferences()).toMatchObject({
    theme: "system",
    openTickets: "expanded",
  });
});

test("the removed reminder switch left in storage is ignored", () => {
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ notifyReminders: true, followCreated: false }),
  );
  const loaded = loadPreferences();
  expect(loaded.followCreated).toBe(false);
  expect(loaded).not.toHaveProperty("notifyReminders");
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

test("the native window follows Light and Dark, and System hands control back", async () => {
  const { renderHook, act, cleanup } = await import("@testing-library/react");
  const { windowClient } = await import("@/lib/api/window");
  const { useThemeSync } = await import("@/lib/preferences");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const setTheme = vi.spyOn(windowClient, "setTheme").mockResolvedValue();
  renderHook(() => useThemeSync());
  expect(setTheme).toHaveBeenLastCalledWith(null);
  act(() => void setPreference("theme", "dark"));
  expect(setTheme).toHaveBeenLastCalledWith("dark");
  act(() => void setPreference("theme", "system"));
  expect(setTheme).toHaveBeenLastCalledWith(null);
  cleanup();
});

test("the window background follows the resolved theme", async () => {
  const { renderHook, act, cleanup } = await import("@testing-library/react");
  const { windowClient } = await import("@/lib/api/window");
  const { useThemeSync } = await import("@/lib/preferences");
  vi.spyOn(windowClient, "setTheme").mockResolvedValue();
  const bg = vi.spyOn(windowClient, "setBackgroundColor").mockResolvedValue();
  renderHook(() => useThemeSync());
  act(() => void setPreference("theme", "light"));
  expect(bg).toHaveBeenLastCalledWith("#FAFAFA");
  act(() => void setPreference("theme", "dark"));
  expect(bg).toHaveBeenLastCalledWith("#0A0A0A");
  cleanup();
});
