// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { loadPreferences } from "@/lib/preferences";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("choosing Dark or Full width is stored and exposed as selected", () => {
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  const checked = (name: string | RegExp) =>
    screen.getByRole("radio", { name }).getAttribute("aria-checked");
  expect(checked("System")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  fireEvent.click(screen.getByRole("radio", { name: /Full width/ }));
  expect(checked("Dark")).toBe("true");
  expect(checked(/Full width/)).toBe("true");
  expect(loadPreferences()).toEqual({ theme: "dark", openTickets: "expanded" });
});

test("the section list only offers sections that have cards", () => {
  render(
    <>
      <SettingsNav onBack={() => {}} />
      <SettingsView hidden={false} onRestore={async () => {}} />
    </>,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const labels = Array.from(nav.querySelectorAll("li button")).map(
    (button) => button.textContent ?? "",
  );
  expect(labels).toEqual([
    "Appearance",
    "Backups",
    "Export",
    "Keyboard shortcuts",
    "About",
  ]);
  for (const label of labels)
    expect(screen.getByRole("region", { name: label })).toBeTruthy();
});
