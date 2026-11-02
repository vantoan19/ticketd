// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { TicketList } from "./TicketList";
import type { RowScope } from "./ticket-row";

afterEach(cleanup);

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "1",
  trashed: false,
  reference: "T-1",
  title: "First ticket",
  status: "Todo",
  body: "",
  tags: [],
  project_id: null,
  effort_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  duplicate_of: null,
  duplicates: [],
  prerequisites: [],
  ...overrides,
});
const scope: RowScope = {
  showEffort: true,
  showProject: true,
  efforts: [{ id: "e1", name: "Launch" }],
  projects: [{ id: "p1", name: "Website" }],
};
function renderList(tickets: Ticket[], props = {}) {
  return render(
    <TicketList
      tickets={tickets}
      selected={null}
      onOpen={vi.fn()}
      bulkSelection={[]}
      onToggle={vi.fn()}
      selectable
      scope={scope}
      {...props}
    />,
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
        prerequisite("T-2", "In progress"),
        prerequisite("T-3", "Todo"),
        prerequisite("T-4", "Done"),
      ],
    }),
  ]);
  expect(screen.getByText("Blocked by T-2 and 1 more")).toBeTruthy();
});

test("shows Ready once prerequisites are done", () => {
  renderList([ticket({ prerequisites: [prerequisite("T-2", "Done")] })]);
  expect(screen.getByText("Ready")).toBeTruthy();
  expect(screen.queryByText(/Blocked/)).toBeNull();
});

test("shows only the status word outside Todo", () => {
  renderList(
    ["In progress", "In review", "Done", "Canceled", "Duplicate"].map(
      (status, index) => ({
        ...ticket({ status, availability: null }),
        id: String(index),
        reference: `T-${index + 1}`,
      }),
    ),
  );
  expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.queryByText(/Blocked/)).toBeNull();
  expect(screen.getByText("In review", { selector: "span" })).toBeTruthy();
});

test("names the canonical ticket of a duplicate", () => {
  renderList([ticket({ status: "Duplicate", duplicate_of: "T-9" })]);
  expect(screen.getByText("Duplicate of T-9")).toBeTruthy();
});

test("shows one context item and tags as pills", () => {
  renderList([
    ticket({
      parent: { reference: "T-7", title: "Parent", trashed: false },
      effort_id: "e1",
      tags: ["ui", "bug"],
    }),
    ticket({ id: "2", reference: "T-2", effort_id: "e1", project_id: "p1" }),
  ]);
  expect(screen.getByText("Parent T-7")).toBeTruthy();
  expect(screen.getAllByText("Launch")).toHaveLength(1);
  expect(screen.queryByText("Website")).toBeNull();
  expect(screen.getByText("ui")).toBeTruthy();
  expect(screen.getByText("bug")).toBeTruthy();
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
    bulkSelection: ["T-1"],
  });
  expect(screen.getByRole("img", { name: "In review" })).toBeTruthy();
  const box = screen.getByRole("checkbox", { name: "Select T-1" });
  expect((box as HTMLInputElement).checked).toBe(true);
  fireEvent.click(box);
  expect(onToggle).toHaveBeenCalledWith("T-1");
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
    reference: `T-${id}`,
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
  // The page holds one of nine Todo tickets; the header says so.
  expect(screen.getByText("1 of 9")).toBeTruthy();
  // A group header already names the status, so its rows do not repeat it.
  expect(screen.queryByText("In progress", { selector: "span" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add Todo ticket" }));
  expect(onAdd).toHaveBeenCalledWith("Todo", expect.any(HTMLButtonElement));
});

test("a Duplicate group's Add action is worded like every group's and hands over its status", () => {
  const onAdd = vi.fn();
  renderList([inStatus(5, "Duplicate")], {
    grouping: { counts: { ...counts, duplicate: 1 }, onAdd },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Duplicate ticket" }));
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
  expect(screen.getByText("In progress", { selector: "span" })).toBeTruthy();
});
