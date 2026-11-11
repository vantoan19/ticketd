// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, vi, test, expect } from "vitest";
import { Inbox } from "./Inbox";
import type { Entry } from "./inboxModel";

const hours = (n: number) => new Date(Date.now() - n * 3600000).toISOString();

let store: Entry[] = [];
const calls: { command: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "set_inbox_read") {
      const ids = args.ids as number[];
      store = store.map((e) =>
        ids.includes(e.id) ? { ...e, read: args.read as boolean } : e,
      );
    }
    if (command === "inbox") {
      const offset = args.offset as number;
      const limit = args.limit as number;
      return store
        .filter((e) => !args.unreadOnly || !e.read)
        .slice(offset, offset + limit);
    }
  }),
}));

function entry(over: Partial<Entry> & Pick<Entry, "id">): Entry {
  return {
    reference: `T-KQ${over.id}`,
    title: `Ticket ${over.id}`,
    kind: "status",
    from_value: "Todo",
    to_value: "Done",
    timestamp: hours(0),
    read: false,
    editing_agent: null,
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  store = [
    entry({ id: 1, reference: "T-KQ1", title: "First" }),
    entry({
      id: 2,
      reference: "T-KQ2",
      title: "Finding",
      kind: "activity",
      from_value: "note-id",
      to_value: "Original note",
      editing_agent: "agent",
    }),
  ];
});
afterEach(cleanup);

test("opening an entry marks it read and shown entries can be marked together", async () => {
  const select = vi.fn();
  render(<Inbox revision={0} select={select} onBrowse={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /T-KQ1.*First/ }));
  expect(select).toHaveBeenCalledWith("T-KQ1");
  await waitFor(() => expect(store[0]?.read).toBe(true));
  const unreadState = { selector: ".sr-only" };
  await waitFor(() =>
    expect(screen.getAllByText("Unread", unreadState)).toHaveLength(1),
  );
  fireEvent.click(screen.getByRole("button", { name: "Mark shown as read" }));
  await waitFor(() =>
    expect(screen.queryByText("Unread", unreadState)).toBeNull(),
  );
  expect(store.every((e) => e.read)).toBe(true);
});

test("opens the note identified by an inbox entry and shows its text", async () => {
  const select = vi.fn();
  render(<Inbox revision={0} select={select} onBrowse={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /T-KQ2.*Finding/ }),
  );
  expect(select).toHaveBeenCalledWith("T-KQ2", "note-id");
  expect(screen.getByText(/New update: Original note · agent/)).toBeTruthy();
});

test("groups entries by local day and never shows internal event keys", async () => {
  store = [
    entry({ id: 1, title: "Now", timestamp: hours(0) }),
    entry({
      id: 2,
      title: "Long ago",
      kind: "relationship:discovered-while",
      from_value: "",
      to_value: "T-KQ9",
      timestamp: hours(24 * 10),
    }),
  ];
  const view = render(
    <Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />,
  );
  await screen.findByText("Long ago");
  expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Earlier" })).toBeTruthy();
  expect(screen.getByText("Discovered while working on T-KQ9")).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/relationship:/);
});

test("the Unread filter asks the core for unread entries and loads older pages", async () => {
  store = Array.from({ length: 60 }, (_, i) =>
    entry({ id: 100 - i, read: i % 2 === 1 }),
  );
  render(<Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />);
  await screen.findByRole("button", { name: /^T-KQ100/ });
  fireEvent.click(screen.getByRole("radio", { name: "Unread" }));
  await waitFor(() =>
    expect(calls.some((c) => c.args.unreadOnly === true)).toBe(true),
  );
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(30));
  expect(screen.queryByRole("button", { name: /^T-KQ99/ })).toBeNull();
  expect(screen.getByText(/That’s everything unread/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
});

test("an empty Inbox explains itself and offers to browse tickets", async () => {
  store = [];
  const onBrowse = vi.fn();
  render(<Inbox revision={0} select={vi.fn()} onBrowse={onBrowse} />);
  await screen.findByText("Nothing in your Inbox");
  const mark = screen.getByRole("button", { name: "Mark shown as read" });
  expect(mark.hasAttribute("disabled")).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Browse tickets to follow" }),
  );
  expect(onBrowse).toHaveBeenCalled();
});

test("loads older entries on request", async () => {
  store = Array.from({ length: 70 }, (_, i) => entry({ id: 200 - i }));
  render(<Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(50));
  fireEvent.click(screen.getByRole("button", { name: "Load older" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(70));
  expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
});

test("row actions are real buttons reachable by keyboard focus and mark one entry", async () => {
  render(<Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />);
  const row = (await screen.findByText("First")).closest("li")!;
  const action = within(row).getByRole("button", {
    name: "Mark T-KQ1 change read",
  });
  action.focus();
  expect(document.activeElement).toBe(action);
  fireEvent.click(action);
  await waitFor(() =>
    expect(
      within(row).getByRole("button", { name: "Mark T-KQ1 change unread" }),
    ).toBeTruthy(),
  );
  expect(store.find((e) => e.id === 2)?.read).toBe(false);
});

test("snoozing a due reminder reschedules it without marking the entry read", async () => {
  store = [
    entry({
      id: 7,
      reference: "T-KQ7",
      title: "Remember",
      kind: "reminder",
      from_value: "",
      to_value: "2020-01-01T00:00:00Z",
    }),
  ];
  render(<Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />);
  expect(await screen.findByText("Your reminder is due")).toBeTruthy();
  const before = Date.now();
  fireEvent.click(
    screen.getByRole("button", { name: "Snooze reminder for T-KQ7" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "In one hour" }));
  await waitFor(() =>
    expect(calls.some((c) => c.command === "set_reminder")).toBe(true),
  );
  const call = calls.find((c) => c.command === "set_reminder")!;
  expect(call.args.reference).toBe("T-KQ7");
  const due = new Date(call.args.dueAt as string).getTime();
  expect(due).toBeGreaterThanOrEqual(before + 3600000 - 1000);
  expect(store[0]!.read).toBe(false);
});

test("only reminders offer Snooze", async () => {
  render(<Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />);
  await screen.findByText("First");
  expect(screen.queryByRole("button", { name: /Snooze/ })).toBeNull();
});

test("a deleted update reads as deleted and opens the ticket with its id", async () => {
  store = [
    entry({
      id: 9,
      title: "Gone",
      kind: "activity",
      from_value: "note-id",
      to_value: "Old",
      deleted: true,
    }),
  ];
  const select = vi.fn();
  render(<Inbox revision={0} select={select} onBrowse={vi.fn()} />);
  expect(await screen.findByText("Update deleted")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Gone/ }));
  expect(select).toHaveBeenCalledWith("T-KQ9", "note-id");
});
