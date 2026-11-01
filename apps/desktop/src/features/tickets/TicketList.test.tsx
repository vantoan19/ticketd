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
