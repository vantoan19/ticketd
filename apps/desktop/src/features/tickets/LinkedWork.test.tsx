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
type Item = {
  reference: string;
  title: string;
  status?: string;
  trashed?: boolean;
  unresolved?: boolean;
};
const related = (item: Item) => ({
  status: "Todo",
  trashed: false,
  unresolved: true,
  ...item,
  title: { text: item.title },
});
const pageOf = (items: Item[] = [], next_offset: number | null = null) => ({
  items: items.map(related),
  next_offset,
});

function bridge(
  options: {
    prerequisites?: Item[];
    blocking?: Item[];
    related?: Item[];
    parent?: Item;
    duplicate_of?: Item;
    duplicates?: Item[];
    more?: number;
    fail?: Record<string, string>;
    never?: boolean;
  } = {},
) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    const failure = options.fail?.[command];
    if (failure) throw failure;
    if (command === "contextual_relationships") {
      if (options.never) return new Promise(() => {});
      return {
        relationships: {
          parent: options.parent ? related(options.parent) : null,
          children: page,
          prerequisites: pageOf(options.prerequisites),
          blocking: pageOf(options.blocking),
          related: pageOf(options.related, options.more ?? null),
          discovered_while: page,
          discoveries: page,
          duplicate_of: options.duplicate_of
            ? related(options.duplicate_of)
            : null,
          duplicates: pageOf(options.duplicates),
        },
      };
    }
    if (command === "search_tickets")
      return [other("T-5", "Target"), other("T-1", "Itself")];
    return base;
  });
}
function renderSection(
  ticket: Ticket,
  refresh = vi.fn(async () => {}),
  onOpenGraph = vi.fn(),
) {
  render(
    <LinkedWork
      ticket={ticket}
      revision={0}
      refresh={refresh}
      select={vi.fn()}
      onOpenGraph={onOpenGraph}
    />,
  );
  return refresh;
}

test("a ticket with no links shows only Link ticket once the read succeeds", async () => {
  bridge();
  renderSection(base);
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(screen.getByRole("button", { name: "Link ticket" })).toBeTruthy();
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Graph" })).toBeNull();
});

test("loading and a failed read are distinct from having no links", async () => {
  bridge({ never: true });
  const view = render(
    <LinkedWork
      ticket={base}
      revision={0}
      refresh={async () => {}}
      select={() => {}}
      onOpenGraph={() => {}}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Loading linked");
  view.unmount();
  bridge({ fail: { contextual_relationships: "database busy" } });
  renderSection(base);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not load linked work: database busy",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("builds every row from the one relationships read, including all dependents", async () => {
  bridge({
    related: [{ reference: "T-4", title: "Sibling" }],
    blocking: [
      { reference: "T-6", title: "Waiting" },
      { reference: "T-7", title: "Also waiting" },
    ],
    prerequisites: [
      {
        reference: "T-2",
        title: "Blocker",
        status: "In progress",
        trashed: true,
      },
    ],
    parent: { reference: "T-3", title: "Epic" },
    duplicate_of: { reference: "T-9", title: "Original", status: "Duplicate" },
  });
  renderSection(base);
  await screen.findByText("Sibling");
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
    "blocked_by",
    "blocks",
    "blocks",
    "parent",
    "related",
    "duplicate_of",
  ]);
  expect(screen.getByText("In progress · not done · in trash")).toBeTruthy();
  expect(screen.getByRole("heading").textContent).toContain("6");
  const commands = vi.mocked(invoke).mock.calls.map((call) => call[0]);
  expect(commands).not.toContain("dependency_graph");
  expect(commands).not.toContain("show_ticket");
});

test("shows n+ and loads the next page when more links exist", async () => {
  bridge({ related: [{ reference: "T-4", title: "Sibling" }], more: 20 });
  renderSection(base);
  await screen.findByText("Sibling");
  expect(screen.getByRole("heading").textContent).toContain("1+");
  expect(screen.getByRole("button", { name: "Show more links" })).toBeTruthy();
});

test("the Graph action opens the dependency graph", async () => {
  bridge({ prerequisites: [{ reference: "T-2", title: "Blocker" }] });
  const onOpenGraph = vi.fn();
  renderSection(base, undefined, onOpenGraph);
  fireEvent.click(await screen.findByRole("button", { name: "Graph" }));
  expect(onOpenGraph).toHaveBeenCalled();
});

test("Remove relationship takes the link off the ticket", async () => {
  bridge({ prerequisites: [{ reference: "T-2", title: "Blocker" }] });
  const refresh = renderSection(base);
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

test("removing a duplicate link explains the result before anything changes", async () => {
  bridge({
    duplicate_of: { reference: "T-9", title: "Original", status: "Todo" },
  });
  const refresh = renderSection({ ...base, duplicate_of: "T-9" });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove relationship: Duplicate of T-9",
    }),
  );
  const confirm = await screen.findByRole("dialog", {
    name: "Remove duplicate link",
  });
  expect(confirm.textContent).toContain("T-1 stops being a duplicate of T-9");
  expect(confirm.textContent).toContain("review them separately");
  expect(invoke).not.toHaveBeenCalledWith(
    "remove_duplicate",
    expect.anything(),
  );
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Remove duplicate link" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "remove_duplicate",
      expect.objectContaining({ source: "T-1" }),
    ),
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

test("choosing a new parent says it replaces the current one", async () => {
  bridge();
  renderSection({
    ...base,
    parent: { reference: "T-3", title: "Epic", trashed: false },
  });
  fireEvent.click(screen.getByRole("button", { name: "Link ticket" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("status")).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Relationship"), {
    target: { value: "parent" },
  });
  expect(within(dialog).getByRole("status").textContent).toBe(
    "This replaces the current parent T-3.",
  );
});
