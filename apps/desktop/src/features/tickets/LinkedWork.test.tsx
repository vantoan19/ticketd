// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LinkedWork } from "@/features/tickets/LinkedWork";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base: Ticket = {
  id: "1",
  reference: "T-1",
  title: "Work",
  body: "",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  effort_id: null,
  availability: "Blocked",
  parent: null,
  children: [],
  prerequisites: [],
};
const page = { items: [], next_offset: null };
const other = (reference: string, title: string, status = "Todo") => ({
  ...base,
  id: reference,
  reference,
  title,
  status,
});

function bridge(
  options: {
    related?: { reference: string; title: string }[];
    blocks?: string[];
    fail?: Record<string, string>;
  } = {},
) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    const failure = options.fail?.[command];
    if (failure) throw failure;
    if (command === "contextual_relationships")
      return {
        relationships: {
          related: {
            items: (options.related ?? []).map((item) => ({
              ...item,
              title: { text: item.title },
              status: "Todo",
              trashed: false,
            })),
            next_offset: null,
          },
          discovered_while: page,
          discoveries: page,
        },
      };
    if (command === "dependency_graph")
      return {
        nodes: [
          { ...base, availability: null },
          ...(options.blocks ?? []).map((reference) => ({
            ...other(reference, "Waiting"),
            availability: null,
          })),
        ],
        edges: (options.blocks ?? []).map((dependent) => ({
          blocker: "T-1",
          dependent,
        })),
        max_nodes: 50,
        max_depth: 2,
        truncated: false,
      };
    if (command === "show_ticket")
      return other("T-9", "Existing original", "Canceled");
    if (command === "search_tickets")
      return [other("T-5", "Target"), other("T-1", "Itself")];
    return base;
  });
}
function renderSection(ticket: Ticket, refresh = vi.fn(async () => {})) {
  render(
    <LinkedWork
      ticket={ticket}
      revision={0}
      refresh={refresh}
      select={vi.fn()}
      graphOpen={false}
      onToggleGraph={vi.fn()}
      graph={null}
    />,
  );
  return refresh;
}

test("a ticket with no links shows only Link ticket", () => {
  bridge();
  renderSection(base);
  expect(screen.getByRole("button", { name: "Link ticket" })).toBeTruthy();
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.queryByText(/No parent|No subtickets/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Graph" })).toBeNull();
});

test("shows every kind of link grouped in order, without expanding anything", async () => {
  bridge({
    related: [{ reference: "T-4", title: "Sibling" }],
    blocks: ["T-6"],
  });
  renderSection({
    ...base,
    prerequisites: [
      {
        reference: "T-2",
        title: "Blocker",
        status: "In progress",
        trashed: true,
      },
    ],
    parent: { reference: "T-3", title: "Epic", trashed: false },
    duplicate_of: "T-9",
  });
  await screen.findByText("Sibling");
  await screen.findByText("Waiting");
  await screen.findByText("Canceled");
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
    "blocked_by",
    "blocks",
    "parent",
    "related",
    "duplicate_of",
  ]);
  expect(screen.getByText("In progress · not done · in trash")).toBeTruthy();
  expect(screen.getByRole("heading").textContent).toContain("5");
  expect(document.querySelector("details")).toBeNull();
});

test("Remove relationship takes the link off the ticket", async () => {
  bridge();
  const refresh = renderSection({
    ...base,
    prerequisites: [
      { reference: "T-2", title: "Blocker", status: "Todo", trashed: false },
    ],
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove relationship: Blocked by T-2",
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("remove_dependency", {
      blocker: "T-2",
      dependent: "T-1",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

async function chooseTarget() {
  fireEvent.click(screen.getByRole("button", { name: "Link ticket" }));
  fireEvent.change(await screen.findByLabelText("Ticket"), {
    target: { value: "target" },
  });
  const matches = await screen.findByRole("list", { name: "Matches" });
  expect(within(matches).queryByText("Itself")).toBeNull();
  fireEvent.click(within(matches).getByRole("button", { name: /T-5/ }));
}

test("Link ticket adds a relationship in the chosen direction", async () => {
  bridge();
  const refresh = renderSection(base);
  await chooseTarget();
  fireEvent.change(screen.getByLabelText("Relationship"), {
    target: { value: "blocks" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Link ticket",
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("add_dependency", {
      blocker: "T-1",
      dependent: "T-5",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a refused link shows the reason inline and keeps the dialog open", async () => {
  bridge({ fail: { add_dependency: "dependency would create a cycle" } });
  renderSection(base);
  await chooseTarget();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Link ticket",
    }),
  );
  expect(await screen.findByText(/would create a cycle/)).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});
