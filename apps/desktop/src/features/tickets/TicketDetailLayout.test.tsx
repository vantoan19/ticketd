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
  reference: "T-1",
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

test("the property rail holds Status, Source, Project, Plan, Tags, Relationships, and Attention in order", async () => {
  renderDetails({ ...ticket, status: "In progress" });
  const rail = await screen.findByRole("complementary", {
    name: "Ticket properties",
  });
  await within(rail).findByRole("button", { name: "Add relationship" });
  expect(
    within(rail)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual([
    "Status",
    "Latest update",
    "Source",
    "Project",
    "Plan",
    "Tags",
    "Documents",
    "Relationships",
    "Attention",
  ]);
  // A local ticket reads Local, with no GitHub mark, in the rail and the state line.
  expect(within(rail).getByText("Local")).toBeTruthy();
  expect(screen.queryByText(/Owned by GitHub/)).toBeNull();
  expect(screen.getByText("Local ticket")).toBeTruthy();
  expect(
    within(rail).getByRole("combobox", { name: "Status: In progress" }),
  ).toBeTruthy();
  expect(
    within(rail).getByRole("button", { name: "Project: No project" }),
  ).toBeTruthy();
});

test("the reading column runs title, state, description, then subtickets, and keeps the rail apart", async () => {
  children = [
    {
      reference: "T-5",
      title: { text: "Part one" },
      status: "Done",
      trashed: false,
      unresolved: false,
    },
  ];
  renderDetails();
  const subtickets = await screen.findByRole("heading", { name: "Subtickets" });
  const title = screen.getByRole("textbox", { name: "Title" });
  const state = screen.getByText("Local ticket");
  const description = screen.getByText("Description");
  const rail = screen.getByRole("complementary", {
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
  const rail = await screen.findByRole("complementary", {
    name: "Ticket properties",
  });
  const follow = await within(rail).findByRole("switch", { name: "Follow" });
  expect(follow.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(follow);
  await waitFor(() =>
    expect(
      within(rail)
        .getByRole("switch", { name: "Follow" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
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
  const rail = await screen.findByRole("complementary", {
    name: "Ticket properties",
  });
  await within(rail).findByRole("button", { name: "Add relationship" });
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
  const heading = screen.getByRole("heading", { name: "Latest update" });
  fireEvent.click(
    await within(heading.closest("section")!).findByRole("button", {
      name: "Go to update",
    }),
  );
  expect(
    (await screen.findByLabelText("Selected update")).textContent,
  ).toContain("Reported progress");
  expect(document.querySelectorAll(".rail-tag")).toHaveLength(2);
});

test("Edit is a real button with its shortcut, and E starts editing", async () => {
  renderDetails({ ...ticket, body: "Some text" });
  const edit = await screen.findByRole("button", { name: "Edit description" });
  expect(edit.textContent).toContain("E");
  fireEvent.keyDown(document.body, { key: "e" });
  expect(
    await screen.findByRole("button", { name: "Done editing" }),
  ).toBeTruthy();
});

test("Subtickets and Evidence own their add actions even when empty", async () => {
  renderDetails();
  const subtickets = (
    await screen.findByRole("heading", { name: "Subtickets" })
  ).closest("section")!;
  expect(
    within(subtickets).getByRole("button", { name: "Add subticket" }),
  ).toBeTruthy();
  const evidence = screen.getByRole("heading", { name: /^Evidence/ });
  expect(
    within(evidence.closest("section")!).getByRole("button", {
      name: "Add evidence",
    }),
  ).toBeTruthy();
});
