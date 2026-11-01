// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TicketHeader } from "./TicketHeader";
import { reminderSummary } from "./reminder-summary";
import type { Ticket } from "@/lib/api/client";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};

const ticket: Ticket = {
  id: "1",
  reference: "T-1",
  title: "Ticket",
  body: "",
  status: "Todo",
  tags: [],
  project_id: null,
  effort_id: null,
  trashed: false,
  availability: null,
  parent: null,
  children: [],
  prerequisites: [],
};
const writeText = vi.fn().mockResolvedValue(undefined);
let reminder: string | null = null;
let following = false;
beforeEach(() => {
  reminder = null;
  following = false;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  bridge.invoke.mockImplementation(async (command: string, args: object) => {
    if (command === "reminder") return reminder;
    if (command === "is_following") return following;
    if (command === "set_following")
      following = (args as { following: boolean }).following;
    if (command === "set_trashed") return { ...ticket, trashed: true };
    return null;
  });
});
afterEach(() => {
  cleanup();
  writeText.mockClear();
  bridge.invoke.mockReset();
  Reflect.deleteProperty(navigator, "clipboard");
});
function header(overrides: Partial<Parameters<typeof TicketHeader>[0]> = {}) {
  const props = {
    selected: "T-1",
    ticket,
    expanded: false,
    onExpand: vi.fn(),
    onReturn: vi.fn(),
    onClose: vi.fn(),
    onOpenGraph: vi.fn(),
    select: vi.fn(),
    refresh: vi.fn(async () => {}),
    updateTicket: vi.fn(),
    ...overrides,
  };
  render(<TicketHeader {...props} />);
  return props;
}
async function chooseAction(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Ticket actions" }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

test("leads with the reference and no repeated Ticket details heading", () => {
  header();
  expect(screen.getByRole("heading", { name: "T-1" })).toBeTruthy();
  expect(screen.queryByText("Ticket details")).toBeNull();
});

test("copies the reference from the header and the context command from the menu", async () => {
  header();
  fireEvent.click(screen.getByRole("button", { name: "Copy reference" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("T-1"));
  await chooseAction("Copy context command");
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(
      "ticketd context T-1 --relationships --notes --evidence",
    ),
  );
});

// The summary follows the locale's time format, so expectations use it too.
const localTime = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

test("summarizes reminder times relative to today in the locale's format", () => {
  const now = new Date(2030, 0, 10, 12, 0);
  const at = (day: number, hour: number, minute: number) =>
    new Date(2030, 0, day, hour, minute);
  expect(reminderSummary(at(10, 15, 5).toISOString(), now)).toBe(
    `Today, ${localTime(at(10, 15, 5))}`,
  );
  expect(reminderSummary(at(11, 9, 0).toISOString(), now)).toBe(
    `Tomorrow, ${localTime(at(11, 9, 0))}`,
  );
  expect(reminderSummary(at(20, 9, 0).toISOString(), now)).toContain(
    localTime(at(20, 9, 0)),
  );
});

test("a reminder whose time has passed says it is due, not scheduled", () => {
  const now = new Date(2030, 0, 10, 12, 0);
  expect(reminderSummary(new Date(2030, 0, 10, 9, 0).toISOString(), now)).toBe(
    "Reminder due",
  );
});

test("the actions menu opens the graph, the duplicate dialog, and trash", async () => {
  const props = header();
  await chooseAction("Open dependency graph");
  expect(props.onOpenGraph).toHaveBeenCalled();
  await chooseAction("Mark as duplicate…");
  expect(
    await screen.findByRole("dialog", { name: "Mark as duplicate" }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Ticket actions" }),
  );
  await chooseAction("Move to trash");
  await waitFor(() => expect(props.updateTicket).toHaveBeenCalled());
  expect(bridge.invoke).toHaveBeenCalledWith("set_trashed", {
    reference: "T-1",
    trashed: true,
  });
});

test("a trashed ticket offers Restore without graph or duplicate actions", async () => {
  header({ ticket: { ...ticket, trashed: true } });
  expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Ticket actions" }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
  expect(await screen.findByRole("menuitem", { name: "Restore" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Move to trash" })).toBeNull();
  expect(
    screen.queryByRole("menuitem", { name: "Open dependency graph" }),
  ).toBeNull();
});

test("shows the position in the list and moves to the neighboring ticket", () => {
  const onAdjacent = vi.fn();
  header({ position: { index: 1, total: 11 }, onAdjacent });
  expect(screen.getByText("1 of 11")).toBeTruthy();
  // The first ticket has nothing before it.
  expect(
    (
      screen.getByRole("button", {
        name: "Previous ticket",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next ticket" }));
  expect(onAdjacent).toHaveBeenCalledWith(1);
});

test("expanded view offers Show beside the list instead of Expand", () => {
  const props = header({ expanded: true });
  expect(screen.queryByRole("button", { name: "Expand ticket" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show beside the list" }));
  expect(props.onReturn).toHaveBeenCalled();
});
