// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { modifierKeyLabel } from "@/lib/platform";
import { KeyboardShortcutsPage } from "@/features/settings/pages/KeyboardShortcutsPage";

afterEach(cleanup);

const filter = () => screen.getByRole("textbox", { name: "Filter shortcuts" });
const groupNames = () =>
  screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);

test("shortcuts are grouped under captioned headings", () => {
  render(<KeyboardShortcutsPage />);
  expect(groupNames()).toEqual(["Lists", "Creating", "Dialogs and menus"]);
  expect(screen.getByText("In any list of tickets.")).toBeTruthy();
  expect(
    screen.getByText("Capture works wherever you are in ticketd."),
  ).toBeTruthy();
  expect(screen.getByText("Focus the divider first.")).toBeTruthy();
  expect(
    screen.getByText(
      "Closes only the foremost dialog, menu or sheet, and never throws away a draft.",
    ),
  ).toBeTruthy();
});

test("keys sit in one labelled column with spoken names", () => {
  render(<KeyboardShortcutsPage />);
  const modifier = modifierKeyLabel();
  const spokenModifier = modifier === "⌘" ? "Command" : "Control";
  const capture = screen.getByRole("img", {
    name: `${spokenModifier} plus Shift plus N`,
  });
  expect(
    Array.from(capture.querySelectorAll("kbd")).map((key) => key.textContent),
  ).toEqual([modifier, "Shift", "N"]);
  expect(
    screen.getByRole("img", { name: "Up arrow or Down arrow" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("img", { name: "Left arrow or Right arrow" }),
  ).toBeTruthy();
  expect(screen.getByRole("img", { name: "Enter" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Escape" })).toBeTruthy();
  expect(
    screen.getByRole("img", { name: `${spokenModifier} plus Enter` }),
  ).toBeTruthy();
});

test("the filter keeps matching shortcuts and the groups that still have one", () => {
  render(<KeyboardShortcutsPage />);
  fireEvent.change(filter(), { target: { value: "resize" } });
  expect(groupNames()).toEqual(["Lists"]);
  const list = screen.getByRole("region", { name: "Lists" });
  expect(within(list).getByText(/Resize the list and detail/)).toBeTruthy();
  expect(within(list).queryByText(/Open the focused ticket/)).toBeNull();
});

test("the filter also matches a note or a spoken key name", () => {
  render(<KeyboardShortcutsPage />);
  fireEvent.change(filter(), { target: { value: "escape" } });
  expect(groupNames()).toEqual(["Dialogs and menus"]);
  fireEvent.change(filter(), { target: { value: "divider" } });
  expect(groupNames()).toEqual(["Lists"]);
});

test("no match says so and Clear filter brings everything back", () => {
  render(<KeyboardShortcutsPage />);
  fireEvent.change(filter(), { target: { value: "zzz" } });
  expect(screen.getByText("No shortcuts match “zzz”")).toBeTruthy();
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect((filter() as HTMLInputElement).value).toBe("");
  expect(groupNames()).toEqual(["Lists", "Creating", "Dialogs and menus"]);
  expect(screen.queryByText(/No shortcuts match/)).toBeNull();
});
