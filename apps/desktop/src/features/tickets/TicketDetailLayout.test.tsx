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
import { TicketDetails } from "./TicketDetails";
import type { Ticket } from "@/lib/api/client";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const page = (items: object[] = []) => ({ items, next_offset: null });
let following = false;
let reminder: string | null = null;
let children: object[] = [];
beforeEach(() => {
  following = false;
  reminder = null;
  children = [];
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "is_following") return following;
    if (command === "set_following")
      following = (args as { following: boolean }).following;
    if (command === "reminder") return reminder;
    if (command === "contextual_relationships") {
      const base = bridgeDefault(command) as {
        relationships: Record<string, unknown>;
      };
      return {
        relationships: {
          ...base.relationships,
          children: page(children),
          children_progress: { total: children.length, done: 0 },
        },
      };
    }
    if (command === "set_following") return null;
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
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
};
function renderDetails(item: Ticket = ticket) {
  render(
    <TicketDetails
      mention={null}
      selected={item.reference}
      expanded={false}
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ [item.reference]: item }}
      projects={[]}
      plans={[]}
      revision={0}
      refresh={vi.fn(async () => {})}
      updateTicket={vi.fn()}
      position={{ index: 2, total: 11 }}
      onAdjacent={vi.fn()}
    />,
  );
}

test("all property chips stay above the description and linked context stays below it", async () => {
  children = [
    {
      reference: "T-KQ5",
      title: { text: "Part one" },
      status: "Todo",
      trashed: false,
      unresolved: true,
    },
  ];
  renderDetails({ ...ticket, status: "In progress" });
  const bar = await screen.findByRole("group", { name: "Ticket properties" });
  expect(
    within(bar).getByRole("combobox", { name: "Status: In progress" }),
  ).toBeTruthy();
  expect(
    within(bar).getByRole("button", { name: "Project: No project" }),
  ).toBeTruthy();
  const linked = await screen.findByRole("heading", { name: "Linked 1" });
  expect(bar.contains(linked)).toBe(false);
  expect(
    screen.getByText("A description to read.").compareDocumentPosition(linked) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByRole("complementary", { name: "Ticket properties" }),
  ).toBeNull();
});

test("the reading column runs title, state, description, then Linked, and keeps properties above it", async () => {
  children = [
    {
      reference: "T-KQ5",
      title: { text: "Part one" },
      status: "Done",
      trashed: false,
      unresolved: false,
    },
  ];
  renderDetails();
  const subtickets = await screen.findByRole("heading", { name: "Linked 1" });
  const title = screen.getByRole("textbox", { name: "Title" });
  const state = document.querySelector(".ticket-state-line")!;
  const description = screen.getByText("Description");
  const rail = screen.getByRole("group", {
    name: "Ticket properties",
  });
  const before = (first: Node, second: Node) =>
    Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  expect(before(title, state)).toBe(true);
  expect(before(state, description)).toBe(true);
  expect(before(description, subtickets)).toBe(true);
  expect(rail.contains(subtickets)).toBe(false);
  expect(rail.contains(title)).toBe(false);
});

test("Follow, the reminder, and the properties live in the rail, not the header", async () => {
  renderDetails();
  const rail = await screen.findByRole("group", {
    name: "Ticket properties",
  });
  const follow = await within(rail).findByRole("button", { name: "Follow" });
  expect(follow.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(follow);
  await waitFor(() =>
    expect(
      within(rail)
        .getByRole("button", { name: "Follow" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  // Visible words follow the state; the name stays "Follow".
  expect(follow.getAttribute("aria-pressed")).toBe("true");
  expect(
    within(rail).getByRole("button", { name: "Manage reminder" }),
  ).toBeTruthy();
  const header = document.querySelector(".detail-header") as HTMLElement;
  expect(within(header).queryByRole("button", { name: /Follow/ })).toBeNull();
  expect(
    within(header).queryByRole("button", { name: /Manage reminder/ }),
  ).toBeNull();
});

test("the header shows the list position with Previous and Next", async () => {
  renderDetails();
  const header = document.querySelector(".detail-header") as HTMLElement;
  expect(within(header).getByText("2 of 11")).toBeTruthy();
  expect(
    (
      within(header).getByRole("button", {
        name: "Previous ticket",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (
      within(header).getByRole("button", {
        name: "Next ticket",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("Latest update appears only for In progress and In review tickets", async () => {
  renderDetails();
  const rail = await screen.findByRole("group", {
    name: "Ticket properties",
  });
  await screen.findByRole("button", { name: "Link a ticket" });
  expect(
    within(rail).queryByRole("heading", { name: "Latest update" }),
  ).toBeNull();
});

test("Latest update jumps to its note and tags appear as separate chips", async () => {
  const note = {
    id: "latest",
    ticket_id: "ticket",
    brief: "Reported progress",
    reported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    editing_agent: "agent",
  };
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "get_activity") return note;
    if (command === "latest_update")
      return {
        activity_id: note.id,
        brief: { text: note.brief, truncated: false },
        reported_at: note.reported_at,
        updated_at: note.updated_at,
        editing_agent: note.editing_agent,
        supporting_document_id: null,
      };
    return bridgeDefault(command, args as { reference?: string });
  });
  renderDetails({
    ...ticket,
    status: "In progress",
    tags: ["frontend", "urgent"],
    latest_update: {
      activity_id: note.id,
      reported_at: note.reported_at,
      editing_agent: "agent",
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: /^Go to update/ }));
  expect(
    (await screen.findByLabelText("Selected update")).textContent,
  ).toContain("Reported progress");
  const rail = screen.getByRole("group", { name: "Ticket properties" });
  // Each tag is its own chip, not one joined string.
  expect(within(rail).getByText("frontend")).toBeTruthy();
  expect(within(rail).getByText("urgent")).toBeTruthy();
});

test("the description owns its shortcut, and E starts editing", async () => {
  renderDetails({ ...ticket, body: "Some text" });
  const edit = await screen.findByRole("group", { name: "Read description" });
  expect(edit.getAttribute("aria-keyshortcuts")).toBe("E");
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  fireEvent.keyDown(document.body, { key: "e" });
  expect(
    await screen.findByRole("button", { name: "Done editing" }),
  ).toBeTruthy();
});

test("an empty ticket folds Subtickets and Evidence into one quiet add row (DB-30)", async () => {
  renderDetails();
  const row = await screen.findByRole("group", {
    name: "Add to this ticket",
  });
  await within(row).findByRole("button", { name: "File" });
  expect(
    within(row)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Subticket", "Link", "Evidence", "File"]);
  // No empty sections stand in a stack under the description.
  expect(screen.queryByRole("heading", { name: "Subtickets" })).toBeNull();
  expect(screen.queryByRole("heading", { name: /^Evidence/ })).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "Evidence" }));
  expect(
    await screen.findByRole("dialog", { name: "Add evidence" }),
  ).toBeTruthy();
});

test("showing another ticket starts its rail and document at the top", async () => {
  const other: Ticket = { ...ticket, id: "2", reference: "T-KQ2" };
  const props = {
    mention: null,
    expanded: false,
    onExpand: vi.fn(),
    onReturn: vi.fn(),
    setSelected: vi.fn(),
    details: { "T-KQ1": ticket, "T-KQ2": other },
    projects: [],
    plans: [],
    revision: 0,
    refresh: vi.fn(async () => {}),
    updateTicket: vi.fn(),
    position: { index: 2, total: 11 },
    onAdjacent: vi.fn(),
  };
  // jsdom never scrolls: store the offset so a reset is observable.
  const offsets = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (
    this: Element,
  ) {
    return offsets.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
    this: Element,
    value: number,
  ) {
    offsets.set(this, value);
  });
  const view = render(<TicketDetails {...props} selected="T-KQ2" />);
  await screen.findAllByRole("group", { hidden: true });
  const scrollers = () => {
    const [shown] = document.querySelectorAll<HTMLElement>(".detail-content");
    return [
      document.querySelector<HTMLElement>(".detail-scroll")!,
      shown!.querySelector<HTMLElement>(".detail-document")!,
    ];
  };
  for (const node of scrollers()) node.scrollTop = 120;
  view.rerender(<TicketDetails {...props} selected="T-KQ1" />);
  for (const node of scrollers()) expect(node.scrollTop).toBe(0);
  vi.restoreAllMocks();
});
