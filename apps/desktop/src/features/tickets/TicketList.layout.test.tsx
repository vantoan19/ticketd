// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import * as rowMotion from "@/components/ui/row-motion";
import type { StatusCounts, Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { frames } from "@/test/motion-clock";
import { motionTestbed, SETTLED_MS } from "@/test/motion-testbed";
import { TicketList } from "./TicketList";
import type { RowScope } from "./ticket-row";

// How the list's rows are measured and moved when the list changes (DESIGN.md
// section 12): the layout dependency every row is given, a ticket that changes
// status, and J/K with a key held down.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@/components/ui/row-motion", async (original) => {
  const real = await original<typeof import("@/components/ui/row-motion")>();
  return { ...real, glide: vi.fn(real.glide) };
});

const testbed = motionTestbed();
const glide = vi.mocked(rowMotion.glide);
beforeEach(() => glide.mockClear());

const ticket = (n: number, overrides: Partial<Ticket> = {}): Ticket => ({
  id: String(n),
  trashed: false,
  reference: `T-KQ${n}`,
  title: `Ticket ${n}`,
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
const tickets = (count: number) =>
  Array.from({ length: count }, (_, i) => ticket(i + 1));
const scope: RowScope = {
  showPlan: true,
  showProject: true,
  plans: [],
  projects: [],
};
const countsOf = (rows: Ticket[]): StatusCounts => {
  const count = (status: string) =>
    rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    todo: count("Todo"),
    in_progress: count("In progress"),
    in_review: count("In review"),
    done: count("Done"),
    canceled: count("Canceled"),
    duplicate: count("Duplicate"),
  };
};

function List({
  rows,
  selected = null,
  onOpen = vi.fn(),
  grouped = true,
}: {
  rows: Ticket[];
  selected?: string | null;
  onOpen?: (reference: string) => void;
  grouped?: boolean;
}) {
  return (
    <MotionProvider>
      <TestReads>
        <TicketList
          tickets={rows}
          selected={selected}
          onOpen={onOpen}
          bulkSelection={[]}
          onToggle={vi.fn()}
          selectable
          scope={scope}
          {...(grouped && { grouping: { counts: countsOf(rows) } })}
        />
      </TestReads>
    </MotionProvider>
  );
}

const rowOf = (title: string) => screen.getByText(title).closest("li")!;
/** The list top to bottom: each group's name, each row's title. */
const sequence = () =>
  [...document.querySelectorAll("ul.ticket-rows > li")].map((item) =>
    item.classList.contains("ticket-group-header")
      ? `[${item.getAttribute("data-status")}]`
      : (item.querySelector(".ticket-title")?.textContent ?? ""),
  );
const orders = () => glide.mock.calls.map(([order]) => String(order));

// layoutDependency: when a row is measured.

test("every row and header is given one dependency, the list order, never none", () => {
  render(<List rows={tickets(3)} />);
  expect(new Set(orders())).toEqual(new Set(["group-Todo,1,2,3"]));
  expect(orders().length).toBeGreaterThanOrEqual(4);
});

test("hover, focus and the open ticket never change it, so a row is not measured for them", () => {
  const rows = tickets(3);
  const { rerender } = render(<List rows={rows} />);
  glide.mockClear();
  fireEvent.pointerEnter(rowOf("Ticket 2"));
  fireEvent.focus(rowOf("Ticket 2").querySelector("button")!);
  rerender(<List rows={rows} selected="T-KQ2" />);
  rerender(<List rows={rows} selected="T-KQ3" />);
  expect(glide).toHaveBeenCalled();
  expect(new Set(orders())).toEqual(new Set(["group-Todo,1,2,3"]));
});

test("a row added or regrouped is a new order, so the rows are measured then", () => {
  const rows = tickets(2);
  const { rerender } = render(<List rows={rows} />);
  glide.mockClear();
  rerender(<List rows={[...rows, ticket(3)]} />);
  expect(orders().at(-1)).toBe("group-Todo,1,2,3");
  glide.mockClear();
  rerender(<List rows={[rows[0]!, ticket(2, { status: "Done" })]} />);
  expect(orders().at(-1)).toBe("group-Todo,1,group-Done,2");
});

test("a flat list is measured on its order too", () => {
  render(<List rows={tickets(2)} grouped={false} />);
  expect(new Set(orders())).toEqual(new Set(["1,2"]));
});

// Regrouping end to end: a ticket that changes status goes to its group.

test("a ticket that changes status moves under its new group", async () => {
  const rows = tickets(3);
  const { rerender } = render(<List rows={rows} />);
  expect(sequence()).toEqual(["[Todo]", "Ticket 1", "Ticket 2", "Ticket 3"]);
  const moving = rowOf("Ticket 2");
  rerender(
    <List rows={[ticket(1), ticket(2, { status: "Done" }), ticket(3)]} />,
  );
  expect(sequence()).toEqual([
    "[Todo]",
    "Ticket 1",
    "Ticket 3",
    "[Done]",
    "Ticket 2",
  ]);
  // The same element moved: it was never unmounted, so it can glide.
  expect(rowOf("Ticket 2")).toBe(moving);
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(rowOf("Ticket 2").style.opacity).toBe("1");
});

test("a ticket under the pointer stays in its group until the pointer leaves, then travels and shows its fill", () => {
  const rows = tickets(3);
  const { rerender } = render(<List rows={rows} />);
  const row = rowOf("Ticket 2");
  fireEvent.pointerEnter(row);
  glide.mockClear();
  rerender(
    <List rows={[ticket(1), ticket(2, { status: "Done" }), ticket(3)]} />,
  );
  // Held where it was, in the group it left, while the pointer is on it.
  expect(sequence()).toEqual(["[Todo]", "Ticket 1", "Ticket 2", "Ticket 3"]);
  expect(glide.mock.calls.some(([, name]) => name === "travel")).toBe(false);
  fireEvent.pointerLeave(row);
  fireEvent.click(document.body);
  expect(sequence()).toEqual([
    "[Todo]",
    "Ticket 1",
    "Ticket 3",
    "[Done]",
    "Ticket 2",
  ]);
  // The moved row takes the longer travel spring, and it alone shows the fill.
  expect(glide.mock.calls.some(([, name]) => name === "travel")).toBe(true);
  expect(row.hasAttribute("data-arrival-fill")).toBe(true);
  expect(rowOf("Ticket 3").hasAttribute("data-arrival-fill")).toBe(false);
});

// J and K with the list focused.

function Navigating({ count }: { count: number }) {
  const [selected, setSelected] = useState<string | null>("T-KQ1");
  return (
    <List rows={tickets(count)} selected={selected} onOpen={setSelected} />
  );
}
const highlight = () => document.querySelectorAll('[data-slot="glide"]');
const press = (title: string, key: string) =>
  fireEvent.keyDown(rowOf(title).querySelector("button")!, {
    key,
    repeat: true,
  });

test("a held J moves the open ticket and its one highlight on every repeat, with motion instant", () => {
  render(<Navigating count={8} />);
  press("Ticket 1", "j");
  expect(document.documentElement.dataset.motion).toBe("instant");
  press("Ticket 2", "j");
  press("Ticket 3", "j");
  expect(highlight()).toHaveLength(1);
  expect(rowOf("Ticket 4").contains(highlight()[0]!)).toBe(true);
  expect(
    rowOf("Ticket 4").querySelector("button")!.getAttribute("aria-pressed"),
  ).toBe("true");
  // And back up the same way.
  press("Ticket 4", "k");
  press("Ticket 3", "k");
  expect(highlight()).toHaveLength(1);
  expect(rowOf("Ticket 2").contains(highlight()[0]!)).toBe(true);
});

test("a held J leaves no row clipped or half arrived", async () => {
  render(<Navigating count={5} />);
  for (const title of ["Ticket 1", "Ticket 2", "Ticket 3"]) press(title, "j");
  await frames();
  for (const item of document.querySelectorAll<HTMLElement>(
    "ul.ticket-rows > li",
  )) {
    expect(item.style.overflow).not.toBe("clip");
    expect(item.style.opacity).toBe("1");
  }
});
