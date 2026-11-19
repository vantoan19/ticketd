// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { TicketList } from "./TicketList";
import type { RowScope } from "./ticket-row";
import { TestReads } from "@/lib/workspace-reads/testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "1",
  trashed: false,
  reference: "T-KQ1",
  title: "First ticket",
  status: "Todo",
  body: "",
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  duplicate_of: null,
  duplicates: [],
  prerequisites: [],
  ...overrides,
});
const scope: RowScope = {
  showPlan: true,
  showProject: true,
  plans: [{ id: "e1", name: "Launch" }],
  projects: [{ id: "p1", name: "Website" }],
};
function renderList(tickets: Ticket[], props = {}) {
  return render(
    <TestReads>
      <TicketList
        tickets={tickets}
        selected={null}
        onOpen={vi.fn()}
        bulkSelection={[]}
        onToggle={vi.fn()}
        selectable
        scope={scope}
        {...props}
      />
    </TestReads>,
  );
}
const prerequisite = (reference: string, status: string) => ({
  reference,
  title: reference,
  status,
  trashed: false,
  // The core says which statuses still block; only Done does.
  unresolved: status !== "Done",
});

test("names an unfinished prerequisite on a blocked Todo ticket", () => {
  renderList([
    ticket({
      availability: "Blocked",
      prerequisites: [
        prerequisite("T-KQ2", "In progress"),
        prerequisite("T-KQ3", "Todo"),
        prerequisite("T-KQ4", "Done"),
      ],
    }),
  ]);
  expect(screen.getByText("Blocked by T-KQ2 and 1 more")).toBeTruthy();
});

test("a ready ticket has no redundant state word", () => {
  renderList([ticket({ prerequisites: [prerequisite("T-KQ2", "Done")] })]);
  expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.queryByText(/Blocked/)).toBeNull();
});

test("names each non-Todo status through its glyph", () => {
  renderList(
    ["In progress", "In review", "Done", "Canceled", "Duplicate"].map(
      (status, index) => ({
        ...ticket({ status, availability: null }),
        id: String(index),
        reference: `T-KQ${index + 1}`,
      }),
    ),
  );
  expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.queryByText(/Blocked/)).toBeNull();
  expect(screen.getByRole("img", { name: "In review" })).toBeTruthy();
});

test("names the canonical ticket of a duplicate", () => {
  renderList([ticket({ status: "Duplicate", duplicate_of: "T-KQ9" })]);
  expect(screen.getByText("Duplicate of T-KQ9")).toBeTruthy();
});

test("shows one context item and tags as pills", () => {
  renderList([
    ticket({
      parent: { reference: "T-KQ7", title: "Parent", trashed: false },
      plan_id: "e1",
      tags: ["ui", "bug"],
    }),
    ticket({ id: "2", reference: "T-KQ2", plan_id: "e1", project_id: "p1" }),
  ]);
  expect(screen.getByText("Subticket of T-KQ7")).toBeTruthy();
  expect(screen.getAllByText("Launch")).toHaveLength(1);
  expect(screen.queryByText("Website")).toBeNull();
  expect(screen.getByText("ui")).toBeTruthy();
  expect(screen.queryByText("bug")).toBeNull();
  expect(screen.getByText("+1")).toBeTruthy();
});

test("omits the project already in scope", () => {
  renderList([ticket({ project_id: "p1" })], {
    scope: { ...scope, showProject: false },
  });
  expect(screen.queryByText("Website")).toBeNull();
});

test("names the status icon and toggles selection", () => {
  const onToggle = vi.fn();
  renderList([ticket({ status: "In review", availability: null })], {
    onToggle,
    bulkSelection: ["T-KQ1"],
  });
  expect(screen.getByRole("img", { name: "In review" })).toBeTruthy();
  const box = screen.getByRole("checkbox", { name: "Select T-KQ1" });
  expect((box as HTMLInputElement).checked).toBe(true);
  fireEvent.click(box);
  expect(onToggle).toHaveBeenCalledWith("T-KQ1");
});

const counts = {
  total: 0,
  todo: 0,
  in_progress: 0,
  in_review: 0,
  done: 0,
  canceled: 0,
  duplicate: 0,
};
const inStatus = (id: number, status: string) =>
  ticket({
    id: String(id),
    reference: `T-KQ${id}`,
    title: `Ticket ${id}`,
    status,
    availability: null,
  });

test("groups rows in workflow order with whole-result counts and an Add action each", () => {
  const onAdd = vi.fn();
  renderList(
    [inStatus(4, "In progress"), inStatus(3, "Todo"), inStatus(2, "Done")],
    {
      grouping: {
        counts: { ...counts, in_progress: 1, todo: 9, done: 1 },
        onAdd,
      },
    },
  );
  const headings = screen.getAllByRole("heading", { level: 2 });
  expect(headings.map((item) => item.textContent)).toEqual([
    "In progress",
    "Todo",
    "Done",
  ]);
  // The header counts the whole group, never the part shown (list R-09).
  expect(screen.getByText("9")).toBeTruthy();
  expect(screen.queryByText("1 of 9")).toBeNull();
  // A group header already names the status, so its rows do not repeat it.
  expect(screen.queryByText("In progress", { selector: "span" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add Todo ticket" }));
  expect(onAdd).toHaveBeenCalledWith("Todo", expect.any(HTMLButtonElement));
});

test("a Duplicate group's Add action names the review it opens and hands over its status", () => {
  const onAdd = vi.fn();
  renderList([inStatus(5, "Duplicate")], {
    grouping: { counts: { ...counts, duplicate: 1 }, onAdd },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Mark a ticket as duplicate…" }),
  );
  expect(onAdd).toHaveBeenCalledWith(
    "Duplicate",
    expect.any(HTMLButtonElement),
  );
});

test("moves keyboard focus across group boundaries and omits empty groups", () => {
  renderList([inStatus(4, "In progress"), inStatus(3, "Done")], {
    grouping: {
      counts: { ...counts, in_progress: 1, done: 1 },
      onAdd: vi.fn(),
    },
  });
  expect(screen.queryByRole("heading", { name: "Todo" })).toBeNull();
  const first = screen.getByRole("button", { name: /Ticket 4/ });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /Ticket 3/ }),
  );
});

test("a flat list has no group headers and names each status", () => {
  renderList([inStatus(4, "In progress")]);
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  expect(screen.getByRole("img", { name: "In progress" })).toBeTruthy();
});

test("rows end with the core update time, never a progress excerpt or a lone no-update note", () => {
  const when = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  renderList([
    ticket({ id: "updated", reference: "T-KQ1", updated_at: when }),
    ticket({
      id: "reported",
      reference: "T-KQ2",
      status: "In progress",
      updated_at: when,
      progress_summary: {
        activity_id: "n1",
        brief: { text: "Verified the fix", truncated: false },
        reported_at: when,
        updated_at: when,
        editing_agent: "agent",
        supporting_document_id: null,
      },
    }),
    ticket({
      id: "unreported",
      reference: "T-KQ3",
      status: "In review",
      updated_at: when,
      progress_summary: null,
    }),
  ]);
  expect(screen.getAllByText(/Updated 3 h ago/)).toHaveLength(3);
  expect(screen.queryByText("Verified the fix")).toBeNull();
  expect(screen.queryByText("No update reported")).toBeNull();
  expect(screen.queryByText("Update unavailable")).toBeNull();
});

test("a Plan and a project carry different icons", () => {
  const { container } = renderList([
    ticket({ id: "1", reference: "T-KQ1", plan_id: "e1" }),
    ticket({ id: "2", reference: "T-KQ2", project_id: "p1" }),
  ]);
  const icon = (name: string) =>
    screen
      .getByText(name)
      .closest(".ticket-row-context")
      ?.querySelector("svg")
      ?.getAttribute("class");
  expect(icon("Launch")).toContain("lucide-layers");
  expect(icon("Website")).toContain("lucide-folder");
  expect(container.querySelectorAll(".ticket-row-context svg")).toHaveLength(2);
});

test("a filtered Todo list omits redundant Ready words", () => {
  renderList([ticket({ availability: "Ready" })], { singleStatus: true });
  expect(screen.queryByText("Ready")).toBeNull();
});

test("the Ready view drops the group header and the Ready dot", () => {
  renderList([ticket({ availability: "Ready" })], {
    singleStatus: true,
    readyView: true,
    grouping: { counts: { ...counts, todo: 1 }, onAdd: vi.fn() },
  });
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.getByRole("button", { name: /First ticket/ })).toBeTruthy();
});

test("a single-status view still shows that a ticket is blocked", () => {
  renderList(
    [
      ticket({
        availability: "Blocked",
        prerequisites: [prerequisite("T-KQ9", "Todo")],
      }),
    ],
    { singleStatus: true },
  );
  expect(screen.getByText("Blocked by T-KQ9")).toBeTruthy();
});

test("one line rows retain context and tags for container collapse", () => {
  renderList(
    [
      ticket({
        tags: ["checkout"],
        plan_id: "e1",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    ],
    { simple: true },
  );
  expect(screen.getByText("T-KQ1")).toBeTruthy();
  expect(screen.getByText("First ticket")).toBeTruthy();
  expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.getByText(/Updated/)).toBeTruthy();
  expect(screen.getByText("checkout")).toBeTruthy();
  expect(screen.getByText("Launch")).toBeTruthy();
});

test("detailed rows show tags and context", () => {
  renderList([ticket({ tags: ["checkout"], plan_id: "e1" })], {
    simple: false,
  });
  expect(screen.getByText("checkout")).toBeTruthy();
  expect(screen.getAllByText("Launch")).toHaveLength(2);
});

test("a blocked row's state carries its full name even when the lane collapses", () => {
  renderList([
    ticket({
      availability: "Blocked",
      prerequisites: [prerequisite("T-KQ9", "Todo")],
    }),
  ]);
  expect(screen.getByLabelText("Blocked by T-KQ9")).toBeTruthy();
});

test("the Ready view leaves out the per-row Ready dot, simple rows too", () => {
  renderList([ticket({})], { simple: true, readyView: true });
  expect(screen.queryByText("Ready")).toBeNull();
});

test("a one line row names blockers without repeating Ready", () => {
  renderList(
    [
      ticket({}),
      ticket({
        id: "t2",
        reference: "T-KQ2",
        title: "Second ticket",
        availability: "Blocked",
        prerequisites: [prerequisite("T-KQ9", "Todo")],
      }),
    ],
    { simple: true },
  );
  expect(screen.getByRole("button", { name: /First ticket/ })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Second ticket.*Blocked/ }),
  ).toBeTruthy();
});

test("the list is one Tab stop and arrows, J/K, Home and End move within it", () => {
  // list R-08: every row used to be its own Tab stop.
  renderList(
    [1, 2, 3].map((n) =>
      ticket({ id: String(n), reference: `T-KQ${n}`, title: `Ticket ${n}` }),
    ),
    { selected: "T-KQ2" },
  );
  const rows = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".ticket-row"));
  const stops = () => rows().filter((row) => row.tabIndex === 0);
  // The open ticket holds the stop until another row takes focus.
  expect(stops()).toEqual([rows()[1]]);
  rows()[1]!.focus();
  fireEvent.keyDown(rows()[1]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows()[2]);
  expect(stops()).toEqual([rows()[2]]);
  fireEvent.keyDown(rows()[2]!, { key: "k" });
  expect(document.activeElement).toBe(rows()[1]);
  fireEvent.keyDown(rows()[1]!, { key: "Home" });
  expect(document.activeElement).toBe(rows()[0]);
  fireEvent.keyDown(rows()[0]!, { key: "End" });
  expect(document.activeElement).toBe(rows()[2]);
  expect(stops()).toHaveLength(1);
});

test("a grouped Todo list says Ready once in its header and flags only Blocked rows", () => {
  renderList(
    [
      ticket(),
      ticket({
        id: "2",
        reference: "T-KQ2",
        availability: "Blocked",
        prerequisites: [prerequisite("T-KQ9", "Todo")],
      }),
    ],
    { grouping: { counts: { ...counts, todo: 2 } } },
  );
  expect(screen.getByText("· 1 ready")).toBeTruthy();
  expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.getByText("Blocked by T-KQ9")).toBeTruthy();
});

test("the open Ticket's row that the list dropped follows the Ticket's own read", async () => {
  const listed = ticket({
    status: "In progress",
    updated_at: "2026-01-01T00:00:00Z",
  });
  const other = ticket({ id: "2", reference: "T-KQ2", status: "In progress" });
  // The Ticket moved to In review; its read has the new copy.
  bridge.invoke.mockResolvedValue({
    ...listed,
    status: "In review",
    updated_at: "2026-01-02T00:00:00Z",
  });
  const view = (tickets: Ticket[]) => (
    <TestReads>
      <TicketList
        tickets={tickets}
        selected="T-KQ1"
        onOpen={vi.fn()}
        bulkSelection={[]}
        onToggle={vi.fn()}
        selectable
        scope={scope}
      />
    </TestReads>
  );
  const { rerender } = render(view([listed, other]));
  rerender(view([other]));
  expect(await screen.findByRole("img", { name: "In review" })).toBeTruthy();
});

test("the list sizes its reference column to its longest reference", () => {
  const { container } = renderList([
    ticket({ id: "1", reference: "T-KQ1" }),
    ticket({ id: "2", reference: "T-VT1000" }),
  ]);
  const rows = container.querySelector<HTMLElement>(".ticket-rows");
  expect(rows?.style.getPropertyValue("--reference-chars")).toBe("8");
});

test("a row held after the list dropped it still has room for its reference", () => {
  const view = (tickets: Ticket[]) => (
    <TestReads>
      <TicketList
        tickets={tickets}
        selected={null}
        onOpen={vi.fn()}
        bulkSelection={["T-VT1000"]}
        onToggle={vi.fn()}
        selectable
        scope={scope}
      />
    </TestReads>
  );
  const short = ticket({ id: "1", reference: "T-VT999" });
  const long = ticket({ id: "2", reference: "T-VT1000" });
  const { container, rerender } = render(view([short, long]));
  // A bulk edit moved the selected ticket out of the view; its row stays.
  rerender(view([short]));
  expect(
    container.querySelector('[data-ticket-reference="T-VT1000"]'),
  ).toBeTruthy();
  const rows = container.querySelector<HTMLElement>(".ticket-rows");
  expect(rows?.style.getPropertyValue("--reference-chars")).toBe("8");
});
