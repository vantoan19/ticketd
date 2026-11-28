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
import { TicketDetails } from "./TicketDetails";
import { TestReads } from "@/lib/workspace-reads/testing";
import type { Ticket } from "@/lib/api/client";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));

// The pane width is the only input: tests set it through the observer.
let callbacks: ResizeObserverCallback[] = [];
window.ResizeObserver = class {
  constructor(callback: ResizeObserverCallback) {
    callbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};
function resizePane(width: number) {
  act(() => {
    for (const callback of callbacks)
      callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
  });
}
Element.prototype.scrollIntoView = () => {};

const changes: object[] = [];
let following = false;
let reminder: string | null = null;
beforeEach(() => {
  callbacks = [];
  following = false;
  reminder = null;
  changes.length = 0;
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket") return ticket;
    if (command === "is_following") return following;
    if (command === "reminder") return reminder;
    if (command === "set_following") {
      following = (args as { following: boolean }).following;
      return null;
    }
    if (command === "change_ticket") {
      changes.push(args as object);
      return { ...ticket, project_id: "p1" };
    }
    return bridgeDefault(command, args as { reference?: string });
  });
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

const ticket: Ticket = {
  id: "1",
  reference: "T-KQ1",
  title: "Ship the rail",
  body: "A description to read.",
  status: "In progress",
  trashed: false,
  tags: ["release"],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
};
function renderDetails(
  record = ticket,
  signal?: ReturnType<typeof fakeChangeSignal>,
) {
  render(
    <TestReads primed={{ ticket: record }} {...(signal && { signal })}>
      <TicketDetails
        mention={null}
        selected={record.reference}
        expanded={false}
        onExpand={vi.fn()}
        onReturn={vi.fn()}
        setSelected={vi.fn()}
        opened={[record.reference]}
        onMentionReady={vi.fn()}
        onClearMention={vi.fn()}
        projects={[{ id: "p1", name: "Web portal" } as never]}
        plans={[]}
        position={{ index: 2, total: 11 }}
        onAdjacent={vi.fn()}
      />
    </TestReads>,
  );
}

test("a wide pane keeps the same wrapping property bar", async () => {
  renderDetails();
  resizePane(900);
  expect(
    await screen.findByRole("group", { name: "Ticket properties" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("complementary", { name: "Ticket properties" }),
  ).toBeNull();
});

test("below a 560px pane the menu carries Copy and the position, and navigation stays in the header", async () => {
  renderDetails();
  resizePane(560);
  const header = screen.getByRole("banner");
  expect(
    within(header).getByRole("button", { name: "Copy reference" }),
  ).toBeTruthy();
  expect(within(header).getByText("2 of 11 in progress")).toBeTruthy();
  resizePane(559);
  expect(
    within(header).queryByRole("button", { name: "Copy reference" }),
  ).toBeNull();
  expect(within(header).queryByText("2 of 11 in progress")).toBeNull();
  for (const name of [
    "Return to ticket list",
    "Previous ticket",
    "Next ticket",
    "Close ticket details",
  ])
    expect(within(header).getByRole("button", { name })).toBeTruthy();
  fireEvent.keyDown(
    within(header).getByRole("button", { name: "Ticket actions" }),
    {
      key: "Enter",
    },
  );
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("2 of 11 in progress")).toBeTruthy();
  expect(
    within(menu).getByRole("menuitem", { name: "Copy reference" }),
  ).toBeTruthy();
});

test("a narrow pane shows only present properties and adds a project through the plus menu", async () => {
  renderDetails();
  resizePane(500);
  const bar = await screen.findByRole("group", { name: "Ticket properties" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(
    within(bar)
      .getAllByRole("button")
      .map((chip) => chip.getAttribute("aria-label")),
  ).toEqual(["Status: In progress", "Tags: release", "Add ticket property"]);
  expect(bar.textContent).not.toContain("Local");
  fireEvent.keyDown(
    within(bar).getByRole("button", { name: "Add ticket property" }),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Tags" })).toBeNull();
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Project",
    "PlanL",
    "ReminderH",
    "Blocked by…B",
    "Parent…",
    "Subticket…",
    "Link a ticket…",
    "Evidence…",
    "File…",
    "Document…",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Project" }));
  fireEvent.click(await screen.findByRole("option", { name: "Web portal" }));
  await waitFor(() =>
    expect(changes).toEqual([expect.objectContaining({ reference: "T-KQ1" })]),
  );
});

test("widening the pane keeps the same bar", async () => {
  renderDetails();
  resizePane(500);
  await screen.findByRole("group", { name: "Ticket properties" });
  resizePane(800);
  expect(
    await screen.findByRole("group", { name: "Ticket properties" }),
  ).toBeTruthy();
});

test("a reminder arriving while Tags is open preserves the picker and its trigger", async () => {
  const signal = fakeChangeSignal();
  renderDetails(ticket, signal);
  resizePane(500);
  const tags = await screen.findByRole("button", { name: "Tags: release" });
  fireEvent.click(tags);
  const search = await screen.findByRole("combobox");
  fireEvent.change(search, { target: { value: "front" } });
  search.focus();

  reminder = "2099-12-31T00:00:00Z";
  await act(async () => signal.change());
  expect(
    await screen.findByRole("button", { name: /^Manage reminder, scheduled/ }),
  ).toBeTruthy();
  expect(screen.getByRole("combobox")).toBe(search);
  expect(document.activeElement).toBe(search);
  expect(search).toHaveProperty("value", "front");
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(tags));
});

test("a hidden pane reports no width and keeps its layout", async () => {
  renderDetails();
  resizePane(900);
  await screen.findByRole("group", { name: "Ticket properties" });
  resizePane(0);
  expect(screen.getByRole("group", { name: "Ticket properties" })).toBeTruthy();
  expect(
    screen.queryByRole("complementary", { name: "Ticket properties" }),
  ).toBeNull();
});

test("narrow, the update card follows the property controls", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "latest_update")
      return {
        activity_id: "a-1",
        brief: { text: "Drafted a fix", truncated: false },
        reported_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        editing_agent: "codex",
        supporting_document_id: null,
      };
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    return bridgeDefault(command, args as { reference?: string });
  });
  renderDetails({ ...ticket, status: "In progress" });
  resizePane(500);
  const bar = await screen.findByRole("group", { name: "Ticket properties" });
  const latest = await screen.findByRole("region", { name: "Latest update" });
  expect(await within(latest).findByText("Drafted a fix")).toBeTruthy();
  // On its own line after the last chip, not between Status and the others.
  const last = within(bar).getByRole("button", { name: "Add ticket property" });
  expect(
    last.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
