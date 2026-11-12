// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPreferences } from "@/lib/preferences";
import { AppearancePage } from "@/features/settings/pages/AppearancePage";

function stubSystemTheme(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: dark,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => stubSystemTheme(false));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test("System says what the operating system is doing right now", () => {
  const { unmount } = render(<AppearancePage />);
  expect(screen.getByRole("radio", { name: /^System/ }).textContent).toContain(
    "Light right now",
  );
  unmount();
  stubSystemTheme(true);
  render(<AppearancePage />);
  expect(screen.getByRole("radio", { name: /^System/ }).textContent).toContain(
    "Dark right now",
  );
});

test("System keeps reporting the operating system after Light or Dark is chosen", () => {
  stubSystemTheme(true);
  render(<AppearancePage />);
  // Choosing a theme changes the native window theme, so the media query
  // then reports the choice, not the operating system.
  stubSystemTheme(false);
  fireEvent.click(screen.getByRole("radio", { name: /^Light/ }));
  expect(screen.getByRole("radio", { name: /^System/ }).textContent).toContain(
    "Dark right now",
  );
});

test("Light and Dark say they are always that theme", () => {
  render(<AppearancePage />);
  expect(screen.getByRole("radio", { name: /^Light/ }).textContent).toContain(
    "Always light",
  );
  expect(screen.getByRole("radio", { name: /^Dark/ }).textContent).toContain(
    "Always dark",
  );
});

test("choosing a theme or an Open tickets layout applies and is stored at once", () => {
  render(<AppearancePage />);
  fireEvent.click(screen.getByRole("radio", { name: /^Dark/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Full width/ }));
  expect(
    screen.getByRole("radio", { name: /^Dark/ }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(loadPreferences()).toMatchObject({
    theme: "dark",
    openTickets: "expanded",
  });
});

test("the two groups are labelled by their headings", () => {
  render(<AppearancePage />);
  expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Open tickets" })).toBeTruthy();
});

test("Open tickets previews follow the resolved theme", () => {
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ theme: "dark" }),
  );
  const { container } = render(<AppearancePage />);
  const split = screen.getByRole("radio", { name: /Beside the list/ });
  expect(
    split
      .querySelector("[data-theme-preview]")
      ?.getAttribute("data-theme-preview"),
  ).toBe("dark");
  expect(
    container.querySelectorAll('[data-theme-preview="dark"]').length,
  ).toBeGreaterThan(2);
});

test("the System preview shows both themes", () => {
  render(<AppearancePage />);
  const system = screen.getByRole("radio", { name: /^System/ });
  const themes = [...system.querySelectorAll("[data-theme-preview]")].map(
    (node) => node.getAttribute("data-theme-preview"),
  );
  expect(themes).toEqual(["light", "dark"]);
});

test("a theme that cannot be saved says so and keeps the old choice", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  render(<AppearancePage />);
  fireEvent.click(screen.getByRole("radio", { name: /^Dark/ }));
  expect(screen.getByRole("alert").textContent).toBe(
    "Could not save the theme.",
  );
  expect(
    screen.getByRole("radio", { name: /^System/ }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("an Open tickets choice that cannot be saved says so", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  render(<AppearancePage />);
  fireEvent.click(screen.getByRole("radio", { name: /Full width/ }));
  expect(screen.getByRole("alert").textContent).toBe(
    "Could not save the Open tickets choice.",
  );
});

test("the panel bar says changes apply right away", () => {
  render(<AppearancePage />);
  expect(screen.getByText("Changes apply right away")).toBeTruthy();
});
