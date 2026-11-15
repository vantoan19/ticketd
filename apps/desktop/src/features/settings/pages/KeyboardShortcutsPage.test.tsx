// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { isMacPlatform } from "@/lib/platform";
import { KeyboardShortcutsPage } from "@/features/settings/pages/KeyboardShortcutsPage";

afterEach(cleanup);

const filter = () =>
  screen.getByRole("searchbox", { name: "Filter shortcuts" });
const groupNames = () =>
  screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
const ALL = [
  "Everywhere",
  "Lists",
  "Ticket",
  "Plans",
  "Chat",
  "Dialogs and menus",
];

test("every real shortcut is listed under its scope", () => {
  render(<KeyboardShortcutsPage />);
  expect(groupNames()).toEqual(ALL);
  // Keys that work but were missing before the registry (list R-08, P18).
  for (const label of [
    "Edit the description",
    "Add the selected text to a Chat",
    "Choose the harness, model and effort",
    "Select the focused ticket for bulk changes",
    "Rename the Plan",
  ])
    expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("Focus the divider first.")).toBeTruthy();
});

test("keys use platform glyphs and are read as words", () => {
  render(<KeyboardShortcutsPage />);
  const mac = isMacPlatform();
  const spokenModifier = mac ? "Command" : "Control";
  const capture = screen.getByRole("img", {
    name: `${spokenModifier} plus Shift plus N`,
  });
  expect(
    Array.from(capture.querySelectorAll("kbd")).map((key) => key.textContent),
  ).toEqual(mac ? ["⌘", "⇧", "N"] : ["Ctrl", "Shift", "N"]);
  expect(
    screen.getAllByRole("img", { name: "Up arrow or Down arrow or J or K" })
      .length,
  ).toBe(1);
  expect(
    screen.getByRole("img", { name: "Left arrow or Right arrow" }),
  ).toBeTruthy();
});

test("the search keeps matching shortcuts and the groups that still have one", () => {
  render(<KeyboardShortcutsPage />);
  fireEvent.change(filter(), { target: { value: "resize" } });
  expect(groupNames()).toEqual(["Lists"]);
  const list = screen.getByRole("region", { name: "Lists" });
  expect(within(list).getByText(/Resize the list and detail/)).toBeTruthy();
  expect(within(list).queryByText(/Open the focused ticket/)).toBeNull();
  fireEvent.change(filter(), { target: { value: "divider" } });
  expect(groupNames()).toEqual(["Lists"]);
});

test("no match says so and Clear search brings everything back", () => {
  render(<KeyboardShortcutsPage />);
  fireEvent.change(filter(), { target: { value: "zzz" } });
  expect(screen.getByText("No shortcuts match “zzz”")).toBeTruthy();
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  fireEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]!);
  expect((filter() as HTMLInputElement).value).toBe("");
  expect(groupNames()).toEqual(ALL);
});

test("navigation sequences are spoken as ordered keys from the registry", () => {
  render(<KeyboardShortcutsPage />);
  for (const key of ["I", "A", "R", "C", "D"])
    expect(screen.getByRole("img", { name: `G then ${key}` })).toBeTruthy();
  fireEvent.change(filter(), { target: { value: "G then D" } });
  expect(screen.getByText("Go to Documents")).toBeTruthy();
  expect(screen.queryByText("Go to Inbox")).toBeNull();
});
