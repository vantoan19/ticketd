// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ChatFeatureContext } from "@/features/chats/use-chats";
import {
  SHORTCUTS,
  requiresChat,
  shortcut,
  shortcutLabel,
  type Shortcut,
} from "@/lib/shortcuts";
import { isMacPlatform } from "@/lib/platform";
import { KeyboardShortcutsPage } from "@/features/settings/pages/KeyboardShortcutsPage";

afterEach(cleanup);

const filter = () =>
  screen.getByRole("searchbox", { name: "Filter shortcuts" });
const groupNames = () =>
  screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
const ALL = ["Everywhere", "Lists", "Ticket", "Plans", "Dialogs and menus"];
const WITH_CHAT = [...ALL.slice(0, 4), "Chat", ...ALL.slice(4)];

function renderWithChat() {
  return render(
    <ChatFeatureContext
      value={{
        enabled: true,
        setEnabled: async () => {},
        overview: { needs_you: 0, unread: 0, app_icon: 0, working: 0 },
        revision: 0,
        openRequest: null,
        chatRequest: null,
        requestChat: () => {},
      }}
    >
      <KeyboardShortcutsPage />
    </ChatFeatureContext>,
  );
}

test("every real shortcut is listed under its scope", () => {
  render(<KeyboardShortcutsPage />);
  expect(groupNames()).toEqual(ALL);
  for (const shortcut of SHORTCUTS.filter(
    (item) => !requiresChat(item) && item.scope !== "Not listed",
  )) {
    const scope = screen.getByRole("region", { name: shortcut.scope });
    expect(within(scope).getByText(shortcut.label)).toBeTruthy();
  }
  expect(screen.getByText("Focus the divider first.")).toBeTruthy();
});

test("a shared condition is said once, in its group's caption", () => {
  render(<KeyboardShortcutsPage />);
  const everywhere = screen.getByRole("region", { name: "Everywhere" });
  expect(
    within(everywhere).getByText(
      "Letter keys pause while you type or while a dialog or menu is open.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "On the open ticket, or the focused one in a list or board.",
    ),
  ).toBeTruthy();
  // The sentence each row used to repeat is gone from the rows.
  expect(screen.queryByText(/Not while typing or with a dialog/)).toBeNull();
  expect(
    screen.queryByText(/On the focused ticket in a list or board/),
  ).toBeNull();
  // A note that adds something stays.
  expect(
    screen.getByText("In the rich editor, this inserts a link."),
  ).toBeTruthy();
  expect(screen.getByText("While Settings is open.")).toBeTruthy();
  expect(screen.getByText("In the update composer.")).toBeTruthy();
});

test("the First run group is gone, and so are its two guide keys", () => {
  render(<KeyboardShortcutsPage />);
  expect(screen.queryByRole("region", { name: "First run" })).toBeNull();
  expect(screen.queryByText("Open Agent skills")).toBeNull();
  expect(screen.queryByText("Open Workspace sync")).toBeNull();
  expect(
    screen.queryByText(/While the guide button or its palette command/),
  ).toBeNull();
  // The guide's tooltip and the palette's chip still read them.
  expect(shortcutLabel("go-sync")).not.toBe("");
  expect(shortcutLabel("go-agent-skills")).not.toBe("");
});

test("Zoom in shows one binding and speaks all three", () => {
  render(<KeyboardShortcutsPage />);
  const mac = isMacPlatform();
  const modifier = mac ? "Command" : "Control";
  const row = screen.getByText("Zoom in").closest("li") ?? document.body;
  const keys = within(row as HTMLElement).getByRole("img", {
    name:
      `${modifier} plus =` +
      ` or ${modifier} plus + or ${modifier} plus Shift plus +`,
  });
  expect(
    Array.from(keys.querySelectorAll("kbd")).map((key) => key.textContent),
  ).toEqual(mac ? ["⌘", "+"] : ["Ctrl", "+"]);
  expect(shortcut("page-zoom-in").keys).toHaveLength(3);
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
  for (const key of ["I", "A", "R", "D"])
    expect(screen.getByRole("img", { name: `G then ${key}` })).toBeTruthy();
  fireEvent.change(filter(), { target: { value: "G then D" } });
  expect(screen.getByText("Go to Documents")).toBeTruthy();
  expect(screen.queryByText("Go to Inbox")).toBeNull();
});

test("every listed row has a key, and no Inbox key is listed twice", () => {
  renderWithChat();
  expect(
    (SHORTCUTS as readonly Shortcut[]).filter(
      (item) => item.keys.length + (item.sequences?.length ?? 0) === 0,
    ),
  ).toEqual([]);
  expect(
    screen.getAllByText(/Mark the .*Inbox entry read or unread/),
  ).toHaveLength(1);
  expect(screen.getAllByText(/Snooze .*Inbox/)).toHaveLength(1);
  const seen = new Map<string, string>();
  for (const item of SHORTCUTS.filter((entry) => entry.scope === "Lists")) {
    const key = JSON.stringify(item.keys);
    if (key.includes('"E"') || key.includes('"H"')) {
      expect(seen.get(key), item.label).toBeUndefined();
      seen.set(key, item.label);
    }
  }
  expect(screen.queryByText("Review workspace notice")).toBeNull();
  expect(screen.queryByText("Go to Automations")).toBeNull();
  expect(screen.queryByText("Expand the New ticket draft")).toBeNull();
  expect(shortcutLabel("new-ticket")).not.toBe("");
});

test("Chat-only keys are hidden while Chat is off and shown when it is on", () => {
  const { unmount } = render(<KeyboardShortcutsPage />);
  expect(groupNames()).toEqual(ALL);
  for (const label of [
    "Go to Chats",
    "Open the approval in Chat",
    "Add the selected text to a Chat",
    "Send, steer or queue, as the button says",
  ])
    expect(screen.queryByText(label)).toBeNull();
  expect(screen.getByText("Go to Documents")).toBeTruthy();
  expect(
    screen.getByText(/In ticket lists and boards, the Inbox, Attachments/),
  ).toBeTruthy();
  unmount();

  renderWithChat();
  expect(groupNames()).toEqual(WITH_CHAT);
  expect(screen.getByText("Go to Chats")).toBeTruthy();
  expect(screen.getByText("Open the approval in Chat")).toBeTruthy();
  expect(screen.getByText("Add the selected text to a Chat")).toBeTruthy();
});

test("the Escape key has one name, Esc, in every key and note", () => {
  for (const item of SHORTCUTS as readonly Shortcut[]) {
    expect(item.keys.flat(), item.id).not.toContain("Escape");
    expect(item.note ?? "", item.id).not.toMatch(/\bEscape\b/);
  }
  expect(shortcutLabel("attachments-back")).toMatch(/Esc/);
});
