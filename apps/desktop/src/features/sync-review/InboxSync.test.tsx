// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  syncReview,
  type ConflictSummary,
  type Notice,
} from "@/lib/sync-review-api";
import { Inbox } from "@/features/tickets/Inbox";

const hours = (n: number) => new Date(Date.now() - n * 3600000).toISOString();

let ordinary: unknown[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "inbox" ? ordinary : undefined,
  ),
}));
vi.mock("@/lib/sync-review-api", () => ({
  syncReview: {
    conflicts: vi.fn(),
    notices: vi.fn(),
    setRead: vi.fn(),
    conflict: vi.fn(() => new Promise(() => {})),
  },
}));

const conflict: ConflictSummary = {
  kind: "ticket",
  id: "guid-12",
  reference: "T-KQ12",
  title: "Rate-limit failed login attempts",
  fields: ["status", "body"],
  detected_at: hours(1),
  read: false,
};
const notices: Notice[] = [
  {
    kind: "dependency_removed",
    id: "notice-1",
    timestamp: hours(0.5),
    read: false,
    reference: "T-MW10",
    title: "Add a login audit log",
    relation: "blocks",
    other: "T-MW9",
  },
  {
    kind: "unreadable_file",
    id: "notice-2",
    timestamp: hours(2),
    read: true,
    path: "tickets/T-MW21.md",
  },
];

const select = vi.fn();
const open = () =>
  render(<Inbox revision={0} select={select} onBrowse={vi.fn()} />);
const entryOf = (text: string | RegExp) => {
  const item = screen.getByText(text).closest("li");
  if (!item) throw new Error("not an Inbox entry");
  return within(item);
};

beforeEach(() => {
  ordinary = [];
  vi.mocked(syncReview.conflicts).mockResolvedValue([conflict]);
  vi.mocked(syncReview.notices).mockResolvedValue(notices);
  vi.mocked(syncReview.setRead).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("a conflict is an Inbox entry that opens the comparison", async () => {
  open();
  const summary = await screen.findByText(
    "Needs review · Status and Description changed on two desktops",
  );
  expect(entryOf(/^Needs review/).getByText("T-KQ12")).toBeTruthy();
  fireEvent.click(summary);
  expect(screen.getByRole("dialog", { name: "Review changes" })).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  expect(syncReview.setRead).toHaveBeenCalledWith(["guid-12"], true);
});

test("notices need no decision: a removed dependency opens its ticket, an unreadable file only reads", async () => {
  open();
  fireEvent.click(
    await screen.findByText(
      "Sync removed “blocks T-MW9” · it would have made a loop",
    ),
  );
  expect(select).toHaveBeenCalledWith("T-MW10");
  expect(syncReview.setRead).toHaveBeenCalledWith(["notice-1"], true);
  const file = entryOf("A Drive file could not be read");
  expect(
    file.getByText("tickets/T-MW21.md was skipped · nothing here changed"),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  // Already read, so its action marks it unread.
  fireEvent.click(file.getByRole("button", { name: /Mark .* unread/ }));
  expect(syncReview.setRead).toHaveBeenCalledWith(["notice-2"], false);
});

test("sync entries sit among the others by time and follow the Unread filter", async () => {
  ordinary = [
    {
      id: 1,
      reference: "T-KQ1",
      title: "Ordinary",
      kind: "status",
      from_value: "Todo",
      to_value: "Done",
      timestamp: hours(0.75),
      read: false,
      editing_agent: null,
    },
  ];
  open();
  await screen.findByText(/^Needs review/);
  const titles = screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".inbox-title")?.textContent);
  expect(titles).toEqual([
    "Add a login audit log",
    "Ordinary",
    "Rate-limit failed login attempts",
    "A Drive file could not be read",
  ]);
  fireEvent.click(screen.getByRole("radio", { name: "Unread" }));
  await waitFor(() =>
    expect(screen.queryByText("A Drive file could not be read")).toBeNull(),
  );
  expect(screen.getByText(/^Needs review/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark shown as read" }));
  await waitFor(() =>
    expect(syncReview.setRead).toHaveBeenCalledWith(
      ["notice-1", "guid-12"],
      true,
    ),
  );
});
