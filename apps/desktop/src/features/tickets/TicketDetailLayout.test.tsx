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
import { TestReads } from "@/lib/workspace-reads/testing";
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
let prerequisites: object[] = [];
let parent: object | null = null;
let history: object[] = [];
let evidence: object[] = [];
let current: Ticket;
const select = vi.fn();
beforeEach(() => {
  following = false;
  reminder = null;
  children = [];
  prerequisites = [];
  parent = null;
  history = [];
  evidence = [];
  select.mockReset();
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    // A reported change reads the open Ticket again.
    if (command === "show_ticket") return current;
    if (command === "ticket_history") return history;
    if (command === "ticket_evidence_page")
      return { items: evidence, total: evidence.length };
    if (command === "search_tickets")
      return [{ ...ticket, reference: "T-KQ9", title: "New prerequisite" }];
    if (command === "add_dependency") return current;
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
          parent,
          children: page(children),
          prerequisites: page(prerequisites),
          children_progress: {
            total: children.length,
            done: children.filter(
              (child) => "status" in child && child.status === "Done",
            ).length,
          },
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
  current = item;
  render(
    <TestReads primed={{ ticket: item }}>
      <TicketDetails
        mention={null}
        selected={item.reference}
        expanded={false}
        onExpand={vi.fn()}
        onReturn={vi.fn()}
        setSelected={select}
        opened={[item.reference]}
        onMentionReady={vi.fn()}
        onClearMention={vi.fn()}
        projects={[
          {
            id: "project",
            name: "Web portal",
            path: "/portal",
            paths: ["/portal"],
          },
        ]}
        plans={[{ id: "plan", name: "Launch", archived: false, purpose: "" }]}
        position={{ index: 2, total: 11 }}
        onAdjacent={vi.fn()}
      />
    </TestReads>,
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
    within(bar).getByRole("button", { name: "Status: In progress" }),
  ).toBeTruthy();
  expect(within(bar).queryByRole("button", { name: /^Project/ })).toBeNull();
  const linked = await screen.findByRole("heading", { name: "Linked" });
  expect(bar.contains(linked)).toBe(false);
  expect(
    screen.getByText("A description to read.").compareDocumentPosition(linked) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByRole("complementary", { name: "Ticket properties" }),
  ).toBeNull();
});

test("the local reading column runs title, description, then Linked without a duplicate timestamp", async () => {
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
  const subtickets = await screen.findByRole("heading", { name: "Linked" });
  const title = screen.getByRole("heading", { name: ticket.title, level: 1 });
  expect(screen.queryByText(/^Updated/)).toBeNull();
  const description = screen.getByText("Description");
  const rail = screen.getByRole("group", {
    name: "Ticket properties",
  });
  const before = (first: Node, second: Node) =>
    Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  expect(before(title, description)).toBe(true);
  expect(before(description, subtickets)).toBe(true);
  expect(rail.contains(subtickets)).toBe(false);
  expect(rail.contains(title)).toBe(false);
});

test("F follows the ticket while a scheduled reminder stays in the context line", async () => {
  reminder = "2030-01-01T12:00:00Z";
  renderDetails();
  const rail = await screen.findByRole("group", {
    name: "Ticket properties",
  });
  fireEvent.keyDown(screen.getByRole("heading", { name: "T-KQ1" }), {
    key: "f",
  });
  expect(bridge.invoke).toHaveBeenCalledWith(
    "set_following",
    expect.objectContaining({ reference: "T-KQ1", following: true }),
  );
  expect(
    await within(rail).findByRole("button", {
      name: /^Manage reminder, scheduled/,
    }),
  ).toBeTruthy();
  expect(within(rail).queryByRole("button", { name: /Follow/ })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "Ticket actions" }), {
    key: "Enter",
  });
  expect(
    await screen.findByRole(
      "menuitemcheckbox",
      {
        name: "Follow",
        checked: true,
      },
      { timeout: 1500 },
    ),
  ).toBeTruthy();
});

test("the header shows the list position with Previous and Next", async () => {
  renderDetails();
  const header = screen.getByRole("banner");
  expect(within(header).getByText("2 of 11 todo")).toBeTruthy();
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

test("a Todo ticket does not reserve a latest update", async () => {
  renderDetails();
  await screen.findByRole("group", { name: "Ticket properties" });
  expect(
    screen.queryByRole("region", { name: "Agents on this ticket" }),
  ).toBeNull();
});

test("Latest update shows its report and tags appear as separate chips", async () => {
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
  const update = within(
    await screen.findByRole("region", { name: "Latest update" }),
  );
  expect(await update.findByText("Reported progress")).toBeTruthy();
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

test("an empty ticket offers Evidence and Files in its context menu", async () => {
  renderDetails();
  const context = await screen.findByRole("group", {
    name: "Ticket properties",
  });
  fireEvent.keyDown(
    within(context).getByRole("button", { name: "Add ticket property" }),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu", { name: "Add ticket property" });
  expect(within(menu).getByRole("menuitem", { name: "File…" })).toBeTruthy();
  expect(
    within(menu).getByRole("menuitem", { name: "Document…" }),
  ).toBeTruthy();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Evidence…" }));
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
    onMentionReady: vi.fn(),
    onClearMention: vi.fn(),
    projects: [],
    plans: [],
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
  const details = (selected: string) => (
    <TestReads primed={{ ticket: [ticket, other] }}>
      <TicketDetails
        {...props}
        opened={["T-KQ1", "T-KQ2"]}
        selected={selected}
      />
    </TestReads>
  );
  const view = render(details("T-KQ2"));
  await screen.findAllByRole("group", { hidden: true });
  const scrollers = () => {
    const [shown] = document.querySelectorAll<HTMLElement>(".detail-content");
    return [
      document.querySelector<HTMLElement>(".detail-scroll")!,
      shown!.querySelector<HTMLElement>(".detail-document")!,
    ];
  };
  for (const node of scrollers()) node.scrollTop = 120;
  view.rerender(details("T-KQ1"));
  for (const node of scrollers()) expect(node.scrollTop).toBe(0);
  vi.restoreAllMocks();
});

test("the context line reads Status, Project / Plan, blockers, subtickets, tags, reminder, then add", async () => {
  const row = (reference: string, title: string, status: string) => ({
    reference,
    title: { text: title },
    status,
    trashed: false,
    unresolved: status !== "Done",
  });
  parent = row("T-KQ2", "Parent outcome", "Todo");
  prerequisites = [
    row("T-KQ3", "Finished work", "Done"),
    row("T-KQ4", "Active prerequisite", "Todo"),
    row("T-KQ6", "Another prerequisite", "In progress"),
  ];
  children = [
    row("T-KQ5", "First part", "Done"),
    row("T-KQ7", "Second part", "Todo"),
  ];
  reminder = "2030-01-01T12:00:00Z";
  renderDetails({
    ...ticket,
    project_id: "project",
    plan_id: "plan",
    tags: ["release", "frontend", "urgent", "review"],
  });
  const bar = screen.getByRole("group", { name: "Ticket properties" });
  await within(bar).findByRole("button", {
    name: /^Manage reminder, scheduled/,
  });
  expect(
    within(bar)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual([
    "Status: Todo",
    "Project / Plan: Web portal / Launch",
    "Blocked by T-KQ4 +1",
    "1 of 2 subtickets",
    "Tags: release, frontend, urgent, review",
    expect.stringMatching(/^Manage reminder, scheduled/),
    "Add ticket property",
  ]);
  expect(within(bar).getByText("release")).toBeTruthy();
  expect(within(bar).getByText("frontend")).toBeTruthy();
  expect(within(bar).queryByText("urgent")).toBeNull();
  expect(within(bar).getByText("+2")).toBeTruthy();
  const parentLink = screen.getByRole("link", { name: "T-KQ2 Parent outcome" });
  const title = screen.getByRole("heading", { level: 1, name: ticket.title });
  expect(
    parentLink.compareDocumentPosition(title) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getAllByText(/Parent outcome/)).toHaveLength(1);
  fireEvent.click(parentLink);
  expect(select).toHaveBeenCalledWith("T-KQ2");
  fireEvent.keyDown(
    within(bar).getByRole("button", { name: "Add ticket property" }),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu", { name: "Add ticket property" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) =>
        item.getAttribute("aria-keyshortcuts")
          ? item.textContent?.slice(0, -1)
          : item.textContent,
      ),
  ).toEqual([
    "Blocked by…",
    "Subticket…",
    "Link a ticket…",
    "Evidence…",
    "File…",
    "Document…",
  ]);
});

test.each(["blockers", "add menu"])(
  "B in the %s opens and submits the blocker workflow",
  async (surface) => {
    prerequisites = [
      {
        reference: "T-KQ3",
        title: { text: "Finished prerequisite" },
        status: "Done",
        trashed: false,
        unresolved: false,
      },
      {
        reference: "T-KQ4",
        title: { text: "Active prerequisite" },
        status: "Todo",
        trashed: false,
        unresolved: true,
      },
    ];
    renderDetails();
    const context = screen.getByRole("group", { name: "Ticket properties" });
    if (surface === "blockers") {
      fireEvent.click(
        await within(context).findByRole("button", {
          name: "Blocked by T-KQ4",
        }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Blockers" });
      expect(
        within(dialog)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "T-KQ4 Active prerequisite · Todo",
        "T-KQ3 Finished prerequisite · Done",
      ]);
      expect(within(dialog).getByText("1 of 2 still open")).toBeTruthy();
      fireEvent.keyDown(
        within(dialog).getByRole("button", { name: "Add a blocker" }),
        { key: "b" },
      );
    } else {
      fireEvent.keyDown(
        within(context).getByRole("button", { name: "Add ticket property" }),
        { key: "Enter" },
      );
      fireEvent.keyDown(
        await screen.findByRole("menuitem", { name: "Blocked by…" }),
        { key: "b" },
      );
    }
    const dialog = await screen.findByRole("dialog", { name: "Link a ticket" });
    expect(
      within(dialog).getByRole("combobox", { name: /Relationship/ })
        .textContent,
    ).toContain("is blocked by");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Ticket" }), {
      target: { value: "New prerequisite" },
    });
    fireEvent.click(
      await within(dialog).findByRole("option", { name: /New prerequisite/ }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Link ticket" }),
    );
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("add_dependency", {
        blocker: "T-KQ9",
        dependent: ticket.reference,
      }),
    );
  },
);

test.each([false, true])(
  "Done shows the completion time, with pull request evidence: %s",
  async (withPR) => {
    const closedAt = new Date(Date.now() - 6 * 3_600_000).toISOString();
    history = [
      {
        kind: "status",
        from_value: "In review",
        to_value: "Done",
        timestamp: closedAt,
        editing_agent: null,
      },
      {
        kind: "project",
        from_value: "",
        to_value: "project",
        timestamp: new Date().toISOString(),
        editing_agent: null,
      },
    ];
    if (withPR)
      evidence = [
        {
          id: "pr",
          kind: "pull_request",
          name: "Pull request",
          value: "https://github.com/ticketd/ticketd/pull/618",
          created_at: closedAt,
          updated_at: closedAt,
          editing_agent: null,
        },
      ];
    renderDetails({
      ...ticket,
      status: "Done",
      updated_at: new Date().toISOString(),
    });
    const time = await screen.findByText("6 h ago");
    expect(time.getAttribute("datetime")).toBe(closedAt);
    expect(time.parentElement?.textContent).toBe("Done 6 h ago");
    const reference = withPR
      ? await screen.findByRole("link", { name: "PR 618" })
      : screen.queryByRole("link", { name: /^PR/ });
    expect(reference?.getAttribute("href") ?? null).toBe(
      withPR ? "https://github.com/ticketd/ticketd/pull/618" : null,
    );
    expect(
      screen.queryByRole("region", { name: "Agents on this ticket" }),
    ).toBeNull();
  },
);

test("Files previews three beside the list and four in the expanded ticket, with a header disclosure", async () => {
  const files = ["report", "logs", "results", "patch", "runbook"].map(
    (name) => ({
      id: name,
      kind: "local_snapshot",
      display_name: `${name}.txt`,
      original_filename: `${name}.txt`,
      locator: `${name}/bytes/${name}.txt`,
      size_bytes: 32,
    }),
  );
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket") return ticket;
    if (command === "ticket_attachments") return files;
    if (command === "attachment_preview")
      return {
        attachment: files.find(
          (file) => file.id === (args as { id: string }).id,
        ),
        status: "unsupported",
        media_type: null,
        message: null,
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    return bridgeDefault(command, args as { reference?: string });
  });
  const props = {
    mention: null,
    selected: ticket.reference,
    setSelected: vi.fn(),
    opened: [ticket.reference],
    onMentionReady: vi.fn(),
    onClearMention: vi.fn(),
    projects: [],
    plans: [],
  };
  const details = (expanded: boolean) => (
    <TestReads primed={{ ticket }}>
      <TicketDetails
        {...props}
        expanded={expanded}
        onExpand={() => view.rerender(details(true))}
        onReturn={() => view.rerender(details(false))}
      />
    </TestReads>
  );
  const view = render(details(false));
  const filesList = await screen.findByRole("list", { name: "Files" });
  const names = () =>
    within(filesList)
      .getAllByRole("button", { name: /\.txt$/ })
      .map((card) => card.getAttribute("aria-label"));
  await within(filesList).findByRole("button", { name: "report.txt" });
  expect(names()).toEqual(["report.txt", "logs.txt", "results.txt"]);
  fireEvent.click(screen.getByRole("button", { name: "Expand ticket" }));
  expect(names()).toEqual([
    "report.txt",
    "logs.txt",
    "results.txt",
    "patch.txt",
  ]);
  const section = within(screen.getByRole("region", { name: "Files 5" }));
  const more = section.getByRole("button", { name: "Show all 5" });
  expect(
    within(filesList).queryByRole("button", { name: "Show all 5" }),
  ).toBeNull();
  expect(section.queryByRole("button", { name: "Attach" })).toBeNull();
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(names()).toEqual([
    "report.txt",
    "logs.txt",
    "results.txt",
    "patch.txt",
    "runbook.txt",
  ]);
  fireEvent.click(section.getByRole("button", { name: "Show less" }));
  expect(names()).toEqual([
    "report.txt",
    "logs.txt",
    "results.txt",
    "patch.txt",
  ]);
});
