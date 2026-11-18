import { revealFailureDetails } from "@/test/failure-details";
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
import { invoke } from "@tauri-apps/api/core";
import { hostFailure } from "@/features/sync/sync-fixtures";
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
    reason: "unknown field 'priority' in a ticket",
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
    file.getByText(
      "tickets/T-MW21.md was skipped · unknown field 'priority' in a ticket",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  // Nothing to open: the row does not act on a click, nor look clickable.
  fireEvent.click(file.getByText(/^tickets\/T-MW21\.md was skipped/));
  expect(select).toHaveBeenCalledTimes(1);
  expect(syncReview.setRead).toHaveBeenCalledTimes(1);
  const row = screen
    .getByText("A Drive file could not be read")
    .closest(".inbox-entry");
  expect(row?.hasAttribute("data-static")).toBe(true);
  // Its summary names a path, so it wraps rather than being cut off.
  expect(row?.hasAttribute("data-wrap")).toBe(true);
  // Already read, so its action marks it unread.
  fireEvent.click(file.getByRole("button", { name: /Mark .* unread/ }));
  expect(syncReview.setRead).toHaveBeenCalledWith(["notice-2"], false);
});

test("a Drive file notice opens the Ticket it belongs to when that Ticket is here", async () => {
  vi.mocked(syncReview.conflicts).mockResolvedValue([]);
  vi.mocked(syncReview.notices).mockResolvedValue([
    {
      kind: "unreadable_file",
      id: "notice-4",
      timestamp: hours(1),
      read: false,
      path: "tickets/T-MW21 Fix login.md",
      reason: "unknown field 'priority' in a ticket",
      ticket_reference: "T-MW21",
    },
  ]);
  open();
  await screen.findByText("A Drive file could not be read");
  const file = entryOf("A Drive file could not be read");
  expect(file.getByText("T-MW21")).toBeTruthy();
  fireEvent.click(file.getByText(/was skipped/));
  expect(select).toHaveBeenCalledWith("T-MW21");
  expect(syncReview.setRead).toHaveBeenCalledWith(["notice-4"], true);
  const row = screen
    .getByText("A Drive file could not be read")
    .closest(".inbox-entry");
  expect(row?.hasAttribute("data-static")).toBe(false);
});

test("a replaced file and a record too large to sync are worded as what they are", async () => {
  const file = { id: "n", timestamp: hours(1), path: "tickets/T-MW21.md" };
  vi.mocked(syncReview.notices).mockResolvedValue([
    {
      ...file,
      kind: "replaced_file",
      read: true,
      reason: "unknown field 'priority' in a ticket",
    },
    {
      ...file,
      id: "m",
      kind: "oversized_record",
      read: false,
      reason: "larger than 8 MiB, the most a record's file may be",
    },
  ]);
  open();
  await screen.findByText("A Drive file was replaced");
  expect(
    entryOf("A Drive file was replaced").getByText(
      "tickets/T-MW21.md could not be read and was replaced by this desktop's version · unknown field 'priority' in a ticket · the earlier file is in Drive's version history",
    ),
  ).toBeTruthy();
  expect(
    entryOf("A record is too large to sync").getByText(
      "tickets/T-MW21.md was not uploaded · larger than 8 MiB, the most a record's file may be · shorten it to sync it",
    ),
  ).toBeTruthy();
});

test("sync entries sit among Updates by time and mark only shown unread entries", async () => {
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
  expect(screen.getByText(/^Needs review/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  await waitFor(() =>
    expect(syncReview.setRead).toHaveBeenCalledWith(
      ["notice-1", "guid-12"],
      true,
    ),
  );
});

test("a removed parent link is a notice naming the parent", async () => {
  vi.mocked(syncReview.conflicts).mockResolvedValue([]);
  vi.mocked(syncReview.notices).mockResolvedValue([
    {
      kind: "parent_removed",
      id: "notice-3",
      timestamp: hours(1),
      read: false,
      reference: "T-MW10",
      title: "Add a login audit log",
      other: "T-KQ4",
    },
  ]);
  open();
  expect(
    await screen.findByText(
      "Sync removed parent T-KQ4 · it would have made a loop",
    ),
  ).toBeTruthy();
});

test("a failed mark as read says what the host reported", async () => {
  const real = (
    await vi.importActual<typeof import("@/lib/sync-review-api")>(
      "@/lib/sync-review-api",
    )
  ).syncReview;
  vi.mocked(syncReview.setRead).mockImplementation(real.setRead);
  vi.mocked(invoke).mockImplementation((command: string) =>
    command === "set_sync_read"
      ? Promise.reject(hostFailure("the Workspace is busy"))
      : Promise.resolve(command === "inbox" ? ordinary : undefined),
  );
  open();
  await screen.findByText(/^Needs review/);
  fireEvent.click(
    entryOf("A Drive file could not be read").getByRole("button", {
      name: /Mark .* unread/,
    }),
  );
  await revealFailureDetails();
  expect(screen.getByText(/the Workspace is busy/)).toBeTruthy();
});
