// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  expect(screen.getByRole("region", { name: "Theme" }).textContent).toContain(
    "is light right now",
  );
  unmount();
  stubSystemTheme(true);
  render(<AppearancePage />);
  expect(screen.getByRole("region", { name: "Theme" }).textContent).toContain(
    "is dark right now",
  );
});

test("System keeps reporting the operating system after Light or Dark is chosen", () => {
  stubSystemTheme(true);
  render(<AppearancePage />);
  // Choosing a theme changes the native window theme, so the media query
  // then reports the choice, not the operating system.
  stubSystemTheme(false);
  fireEvent.click(screen.getByRole("radio", { name: /^Light/ }));
  expect(screen.getByRole("region", { name: "Theme" }).textContent).toContain(
    "is dark right now",
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

test("Open tickets explains each layout and stores the choice for the next ticket", () => {
  render(<AppearancePage />);
  const beside = screen.getByRole("radio", {
    name: /^Beside the list/,
  });
  expect(
    within(beside).getByText(
      "The list narrows so you can move with J and K while you read.",
    ),
  ).toBeTruthy();
  expect(beside.getAttribute("aria-checked")).toBe("true");
  const full = screen.getByRole("radio", {
    name: /^Full width/,
  });
  expect(
    within(full).getByText(
      "The ticket takes the whole panel; Esc returns to the list.",
    ),
  ).toBeTruthy();
  fireEvent.click(full);
  expect(loadPreferences().openTickets).toBe("expanded");
  fireEvent.click(beside);
  expect(loadPreferences().openTickets).toBe("split");
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
  // The failure sits under the group that failed, not under Open tickets.
  const theme = screen.getByRole("region", { name: "Theme" });
  expect(within(theme).getByRole("alert").textContent).toContain(
    "Couldn't save the theme.",
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
  const open = screen.getByRole("region", { name: "Open tickets" });
  expect(within(open).getByRole("alert").textContent).toContain(
    "Couldn't save the Open tickets choice.",
  );
});

test("the panel bar carries no note: a choice simply takes effect", () => {
  render(<AppearancePage />);
  expect(screen.queryByText("Changes apply right away")).toBeNull();
  expect(document.querySelector(".settings-page-lede")?.textContent).toBe(
    "How ticketd looks on this computer.",
  );
});
