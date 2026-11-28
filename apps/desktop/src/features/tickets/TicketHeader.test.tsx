// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StatusLineRegion } from "@/components/ui/status-line";
import { TicketHeader } from "./TicketHeader";
import { TicketListSync } from "./open-ticket";
import { TestReads } from "@/lib/workspace-reads/testing";
import { reminderSummary } from "./reminder-summary";
import {
  ChatFeatureContext,
  NO_CHAT_OVERVIEW,
  type ChatFeature,
} from "@/features/chats/use-chats";
import type { Ticket } from "@/lib/api/client";
import {
  clearWorkspaceFailure,
  reportWorkspaceFailure,
} from "@/lib/workspace-state";

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
  reference: "T-KQ1",
  title: "Ticket",
  body: "",
  status: "Todo",
  tags: [],
  project_id: null,
  plan_id: null,
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
    if (command === "ticket_export_markdown")
      return "# T-KQ1 · Ticket\n\n**Acceptance criteria**";
    if (command === "is_following") return following;
    if (command === "set_following")
      following = (args as { following: boolean }).following;
    if (command === "set_trashed") return { ...ticket, trashed: true };
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearWorkspaceFailure();
  writeText.mockClear();
  bridge.invoke.mockReset();
  Reflect.deleteProperty(navigator, "clipboard");
});
function header(
  overrides: Partial<Parameters<typeof TicketHeader>[0]> = {},
  requestChat?: ChatFeature["requestChat"],
) {
  const props = {
    selected: "T-KQ1",
    ticket,
    expanded: false,
    onExpand: vi.fn(),
    onReturn: vi.fn(),
    onClose: vi.fn(),
    onOpenGraph: vi.fn(),
    select: vi.fn(),
    ...overrides,
  };
  const listed = vi.fn();
  render(
    <TestReads primed={props.ticket ? { ticket: props.ticket } : {}}>
      <TicketListSync value={listed}>
        <StatusLineRegion>
          {requestChat ? (
            <ChatFeatureContext
              value={{
                enabled: true,
                requestChat,
                setEnabled: async () => {},
                overview: NO_CHAT_OVERVIEW,
                revision: 0,
                openRequest: null,
                chatRequest: null,
              }}
            >
              <TicketHeader {...props} />
            </ChatFeatureContext>
          ) : (
            <TicketHeader {...props} />
          )}
        </StatusLineRegion>
      </TicketListSync>
    </TestReads>,
  );
  return { ...props, listed };
}
function openActions() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Ticket actions" }), {
    key: "Enter",
  });
}

async function chooseAction(name: string) {
  openActions();
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

test("Chat about a ticket keeps the link without preselecting an archived Project checkout", async () => {
  const requestChat = vi.fn();
  header(
    {
      ticket: { ...ticket, project_id: "archived" },
      projects: [
        {
          id: "archived",
          name: "Old repo",
          path: "/work/archive",
          paths: ["/work/archive"],
          archived: true,
        },
      ],
    },
    requestChat,
  );
  await chooseAction("Chat about this ticket");
  expect(requestChat).toHaveBeenCalledWith({
    kind: "new",
    start: {
      ticket: {
        kind: "ticket",
        id: "1",
        reference: "T-KQ1",
        title: "Ticket",
        status: "Todo",
      },
      folder: null,
    },
  });
});

test("leads with the reference and no repeated Ticket details heading", () => {
  header();
  expect(screen.getByRole("heading", { name: "T-KQ1" })).toBeTruthy();
  expect(screen.queryByText("Ticket details")).toBeNull();
  expect(within(screen.getByRole("banner")).queryByText("Ticket")).toBeNull();
});

test("shows the title after the reference when scrolled", () => {
  header({
    scrolled: true,
    ticket: { ...ticket, title: "A long ticket title" },
  });
  const banner = screen.getByRole("banner");
  const reference = within(banner).getByRole("heading", { name: "T-KQ1" });
  const title = within(banner).getByText("A long ticket title");
  expect(
    reference.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("keeps the source link accessible and copies its URL from the menu", async () => {
  const url = "https://github.com/acme/api/issues/98";
  header({
    ticket: {
      ...ticket,
      source: {
        provider: "github",
        provider_name: "GitHub",
        place: "acme/api",
        place_label: "acme / api",
        number: "#98",
        status_choices: ["Todo", "In progress", "In review"],
        id: "42",
        locator: "acme/api#98",
        display: "acme/api#98",
        url,
        origin: "imported",
        ownership: "external",
        state: { category: "open", name: "Open" },
        closure_unrecognized: false,
        last_refreshed_at: null,
        last_attempt_at: null,
        last_error: null,
        content_locked: true,
        status_locked: false,
        duplicate_target: null,
      },
    },
  });
  expect(
    screen
      .getByRole("link", { name: "Open on GitHub: acme / api #98" })
      .getAttribute("href"),
  ).toBe(url);
  await chooseAction("Copy link");
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
});

test("copies the reference, the export Markdown and the agent context command", async () => {
  header();
  fireEvent.click(screen.getByRole("button", { name: "Copy reference" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("T-KQ1"));
  await chooseAction("Copy as Markdown");
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(
      "# T-KQ1 · Ticket\n\n**Acceptance criteria**",
    ),
  );
  expect(bridge.invoke).toHaveBeenCalledWith("ticket_export_markdown", {
    reference: "T-KQ1",
  });
  await chooseAction("Copy for an agent");
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(
      "ticketd context T-KQ1 --relationships --activities --evidence",
    ),
  );
});

test("the actions menu captions the update and orders the available actions", async () => {
  following = true;
  header({ ticket: { ...ticket, updated_at: "2025-01-01T12:00:00Z" } });
  expect(screen.queryByText(/^Updated /)).toBeNull();
  openActions();
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText(/^Updated /)).toBeTruthy();
  expect(
    ["menuitem", "menuitemcheckbox", "separator"]
      .flatMap((role) => within(menu).getAllByRole(role))
      .sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
      )
      .map(
        (row) =>
          row.getAttribute("aria-label") ?? row.textContent?.trim() ?? "",
      ),
  ).toEqual([
    "Copy reference",
    "Copy as Markdown",
    "Copy for an agent",
    "",
    "Follow",
    "Remind me…",
    "Open in graph",
    "History…",
    "Export Markdown with files…",
    "Mark as duplicate…",
    "",
    "Move to Trash",
  ]);
  expect(
    within(menu).getByText(
      "ticketd context T-KQ1 --relationships --activities --evidence",
    ),
  ).toBeTruthy();
  expect(
    within(menu).getByText("Updates and approvals reach your Inbox"),
  ).toBeTruthy();
  await within(menu).findByRole("menuitemcheckbox", {
    name: "Follow",
    checked: true,
  });
});

test("Follow offers its failed write again when the workspace unlocks", async () => {
  const invoke = bridge.invoke.getMockImplementation()!;
  let lockedOrFailing = true;
  bridge.invoke.mockImplementation(async (command: string, args: object) => {
    if (command === "set_following" && lockedOrFailing)
      throw { code: "failed", message: "Follow write failed" };
    return invoke(command, args);
  });
  header();
  openActions();
  fireEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Follow" }),
  );
  await screen.findByRole("button", { name: "Retry" });

  act(() => {
    reportWorkspaceFailure("workspace_locked", "Locked");
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn't follow T-KQ1",
  );
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(following).toBe(false);

  lockedOrFailing = false;
  act(() => clearWorkspaceFailure());
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(following).toBe(true));
});

test("Follow can retry a failed read while the workspace is locked", async () => {
  const invoke = bridge.invoke.getMockImplementation()!;
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("Follow read failed"))
    .mockResolvedValue(true);
  bridge.invoke.mockImplementation(async (command: string, args: object) =>
    command === "is_following" ? read() : invoke(command, args),
  );
  reportWorkspaceFailure("workspace_locked", "Locked");
  header();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
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
  await chooseAction("Open in graph");
  expect(props.onOpenGraph).toHaveBeenCalled();
  await chooseAction("Mark as duplicate…");
  expect(
    await screen.findByRole("dialog", { name: "Mark T-KQ1 as a duplicate" }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Ticket actions" }),
  );
  await chooseAction("Move to Trash");
  await waitFor(() => expect(props.listed).toHaveBeenCalled());
  expect(bridge.invoke).toHaveBeenCalledWith("set_trashed", {
    reference: "T-KQ1",
    trashed: true,
  });
});

test("Move to Trash says so in the status line with Undo, never in the header", async () => {
  const props = header();
  const heading = screen.getByRole("heading", { name: "T-KQ1" });
  const headerRow = heading.closest(".detail-header")!;
  const childrenBefore = headerRow.childElementCount;
  await chooseAction("Move to Trash");
  const line = await screen.findByRole("status", {
    name: (_, element) =>
      element.textContent?.includes("Moved T-KQ1 to Trash") ?? false,
  });
  // R1.8: the header no longer grows a message row.
  expect(headerRow.childElementCount).toBe(childrenBefore);
  fireEvent.click(within(line).getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("set_trashed", {
      reference: "T-KQ1",
      trashed: false,
    }),
  );
  await waitFor(() => expect(props.listed).toHaveBeenCalledTimes(2));
});

test("a trashed ticket offers Restore without graph or duplicate actions", async () => {
  header({ ticket: { ...ticket, trashed: true } });
  // The header keeps its shape: Restore is in the menu and the Trash notice.
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Ticket actions" }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
  expect(await screen.findByRole("menuitem", { name: "Restore" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Open in graph" })).toBeNull();
});

test("shows the position in the list and moves to the neighboring ticket", () => {
  const onAdjacent = vi.fn();
  header({ position: { index: 1, total: 11 }, onAdjacent });
  expect(screen.getByText("1 of 11 todo")).toBeTruthy();
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

test("a ticket outside the list keeps the position slot, so the icons never move", () => {
  header({ position: null, outsideResults: true, onAdjacent: vi.fn() });
  expect(screen.getByLabelText("Not in the current results").textContent).toBe(
    "–",
  );
  for (const name of ["Previous ticket", "Next ticket"])
    expect(screen.getByRole("button", { name })).toHaveProperty(
      "disabled",
      true,
    );
});

test("Next onto the last ticket hands focus to Previous, not to nowhere", () => {
  const onAdjacent = vi.fn();
  const props = {
    selected: "T-KQ1",
    ticket,
    expanded: false,
    onExpand: vi.fn(),
    onReturn: vi.fn(),
    onClose: vi.fn(),
    onOpenGraph: vi.fn(),
    onAdjacent,
  };
  const view = render(
    <TestReads>
      <StatusLineRegion>
        <TicketHeader {...props} position={{ index: 1, total: 2 }} />
      </StatusLineRegion>
    </TestReads>,
  );
  const next = screen.getByRole("button", { name: "Next ticket" });
  next.focus();
  fireEvent.click(next);
  view.rerender(
    <TestReads>
      <StatusLineRegion>
        <TicketHeader
          {...props}
          selected="T-KQ2"
          ticket={{ ...ticket, id: "2", reference: "T-KQ2" }}
          position={{ index: 2, total: 2 }}
        />
      </StatusLineRegion>
    </TestReads>,
  );
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Previous ticket" }),
  );
});

test("expanded view offers Show beside the list instead of Expand", () => {
  const props = header({ expanded: true });
  expect(screen.queryByRole("button", { name: "Expand ticket" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show beside the list" }));
  expect(props.onReturn).toHaveBeenCalled();
});

test("History… in the ticket actions opens the ticket's History", async () => {
  header();
  await chooseAction("History…");
  expect(await screen.findByRole("dialog", { name: "History" })).toBeTruthy();
  expect(screen.getByText("T-KQ1 · Ticket")).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("record_versions", {
    kind: "ticket",
    id: "1",
    source: "local",
  });
});
