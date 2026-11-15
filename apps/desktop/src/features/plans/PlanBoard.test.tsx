// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import type { FindFilter, Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});
Element.prototype.scrollIntoView = () => {};

function ticket(id: number, status = "Todo", plan = "launch"): Ticket {
  return {
    id: String(id),
    reference: `T-KQ${id}`,
    title: `Ticket ${id}`,
    body: "",
    status,
    trashed: false,
    tags: [],
    project_id: id % 2 ? "alpha" : "beta",
    plan_id: plan,
    availability: status === "Todo" ? "Ready" : null,
    parent: null,
    children: [],
    prerequisites: [],
  };
}
let saved: Ticket[];
let plans: Plan[];
let change: number;
let readOverride: ((filter: FindFilter) => Promise<unknown> | null) | null;
function matching(filter: FindFilter) {
  return saved.filter(
    (item) =>
      !item.trashed &&
      (!filter.plan || item.plan_id === filter.plan) &&
      (!filter.status || item.status === filter.status) &&
      (!filter.query || item.title.includes(filter.query)) &&
      (!filter.project || item.project_id === filter.project) &&
      (!filter.unlinked || item.project_id === null) &&
      (!filter.availability || item.availability === filter.availability) &&
      (!filter.family || item.parent?.reference === filter.family) &&
      filter.tags.every((tag) => item.tags.includes(tag)),
  );
}
function counts(items: Ticket[]) {
  return {
    total: items.length,
    todo: items.filter((item) => item.status === "Todo").length,
    in_progress: items.filter((item) => item.status === "In progress").length,
    in_review: items.filter((item) => item.status === "In review").length,
    done: items.filter((item) => item.status === "Done").length,
    canceled: items.filter((item) => item.status === "Canceled").length,
    duplicate: items.filter((item) => item.status === "Duplicate").length,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  saved = [ticket(1), ticket(2, "Done"), ticket(3, "In review", "beta-plan")];
  plans = [
    {
      id: "launch",
      name: "Launch",
      archived: false,
      purpose: "Ship across projects",
    },
    {
      id: "beta-plan",
      name: "Next release",
      archived: false,
      purpose: "Prepare next release",
    },
  ];
  change = 0;
  readOverride = null;
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: {
        filter?: FindFilter;
        reference?: string;
        id?: string;
        archived?: boolean | null;
      },
    ) => {
      if (command === "workspace_change_token") return change;
      if (command === "list_projects")
        return [
          { id: "alpha", name: "Alpha", path: "/alpha", paths: ["/alpha"] },
          { id: "beta", name: "Beta", path: "/beta", paths: ["/beta"] },
        ];
      if (command === "list_plans") return plans;
      if (command === "change_plan") {
        plans = plans.map((item) =>
          item.id === args?.id &&
          args.archived !== null &&
          args.archived !== undefined
            ? { ...item, archived: args.archived }
            : item,
        );
        return;
      }
      if (command === "show_plan") {
        const members = saved.filter(
          (item) => !item.trashed && item.plan_id === args?.id,
        );
        return {
          plan: {
            ...plans.find((item) => item.id === args?.id),
            spec_document_id: "spec",
          },
          members,
          counts: counts(members),
          documents: [
            { id: "spec", heading: "Release specification", trashed: false },
          ],
        };
      }
      if (command === "plan_dependency_graph")
        return {
          nodes: saved
            .filter((item) => !item.trashed && item.plan_id === args?.id)
            .slice(0, 1)
            .map((item) => ({ ...item, boundary: false })),
          edges: [],
          total_members: saved.filter(
            (item) => !item.trashed && item.plan_id === args?.id,
          ).length,
          max_nodes: 50,
          max_depth: 1,
          max_edges: 300,
          max_work: 3000,
          omitted_neighbors: false,
          omitted_edges: false,
          truncated: true,
        };
      if (command === "find_tickets_with_updates" && args?.filter) {
        const override = readOverride?.(args.filter);
        if (override) return override;
        const { offset, limit } = args.filter;
        if (limit > 50) throw new Error("Search batches must remain bounded");
        return matching(args.filter)
          .slice(offset, offset + limit)
          .map((ticket) => ({ ticket, latest_update: null }));
      }
      if (command === "count_tickets" && args?.filter)
        return counts(matching(args.filter));
      if (command === "show_ticket")
        return saved.find((item) => item.reference === args?.reference);
      return bridgeDefault(command, args);
    },
  );
});

test("workspace changes refresh Plan membership, status, counts, and readiness without replacing a selected ticket draft", async () => {
  render(<App />);
  await settle();
  await openPlan();
  chooseView("Board");
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^T-KQ1\D/ }));
  // The next workspace poll arrives while this newly typed draft is still unsaved.
  await settle(1900);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "My unsaved title" },
  });
  saved = [
    { ...ticket(1, "Todo", "beta-plan"), title: "Changed elsewhere" },
    ticket(2, "In review"),
    ticket(3, "In review", "beta-plan"),
    {
      ...ticket(4),
      availability: "Blocked",
      prerequisites: [
        {
          reference: "T-KQ2",
          title: "Ticket 2",
          status: "In review",
          trashed: false,
          unresolved: true,
        },
      ],
    },
  ];
  change++;
  await settle(100);
  const board = within(
    screen.getByRole("region", { name: "Ticket status board" }),
  );
  expect(board.queryByRole("button", { name: /^T-KQ1\D/ })).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "In review column" })).getByRole(
      "button",
      { name: /^T-KQ2\D/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: /^T-KQ4\D/ })).getByText(
      "Blocked by T-KQ2",
    ),
  ).toBeTruthy();
  // Per-status counts live in the columns; the header keeps the progress.
  expect(screen.getByText("0 of 2 done")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "My unsaved title",
  );
  expect(screen.getByText(/outside the current results/i)).toBeTruthy();
});

test("a delayed previous Plan response cannot replace the current Plan's Board or header", async () => {
  render(<App />);
  await settle();
  await openPlan();
  chooseView("Board");
  await settle();
  const finishes: ((value: unknown) => void)[] = [];
  readOverride = (filter) =>
    filter.plan === "launch" && filter.status === "Todo"
      ? new Promise((resolve) => {
          finishes.push(resolve);
        })
      : null;
  change++;
  await settle(2000);
  expect(finishes.length).toBeGreaterThan(0);
  await openPlan("Next release");
  await act(async () => {
    for (const finish of finishes)
      finish([{ ticket: ticket(1), latest_update: null }]);
  });
  expect(screen.getByRole("heading", { name: "Next release" })).toBeTruthy();
  expect(screen.getByText("Prepare next release")).toBeTruthy();
  const board = within(
    screen.getByRole("region", { name: "Ticket status board" }),
  );
  expect(board.getByRole("button", { name: /^T-KQ3\D/ })).toBeTruthy();
  expect(board.queryByRole("button", { name: /^T-KQ1\D/ })).toBeNull();
  expect(screen.getByText("0 of 1 done")).toBeTruthy();
});

test("archiving a Plan on Board preserves ticket editing and restricts Plan membership until reactivation", async () => {
  render(<App />);
  await settle();
  await openPlan();
  chooseView("Board");
  await settle();
  fireEvent.keyDown(screen.getByRole("button", { name: "Plan actions" }), {
    key: "Enter",
  });
  await settle();
  // Archiving is reversible, so it acts at once (Undo on the status line).
  fireEvent.click(screen.getByRole("menuitem", { name: /^Archive Plan/ }));
  await settle();
  expect(
    screen.getByText("Archived", { selector: '[data-slot="badge"]' }),
  ).toBeTruthy();
  expect(
    screen.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: "Add to Plan…" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Edit purpose/ })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Actions for Release specification" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /^Remove T-.* from Launch/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^T-KQ1\D/ }));
  await settle();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "disabled",
    false,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Allowed ticket draft" },
  });
  chooseView("List");
  await settle();
  expect(
    screen.queryByRole("button", { name: /^Remove T-.* from Launch/ }),
  ).toBeNull();
  chooseView("Board");
  await settle();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Allowed ticket draft",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
  await settle();
  expect(
    screen.queryByText("Archived", { selector: '[data-slot="badge"]' }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Add to Plan…" })).toBeTruthy();
});

test("Plan ticket details retain their draft and return to the same Board position and card focus after Dependencies", async () => {
  render(<App />);
  await settle();
  await openPlan();
  chooseView("Board");
  await settle();
  const board = screen.getByRole("region", { name: "Ticket status board" });
  board.scrollLeft = 420;
  const card = within(board).getByRole("button", { name: /^T-KQ1\D/ });
  card.focus();
  fireEvent.click(card);
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Keep my Plan ticket draft" },
  });
  chooseView("Dependencies");
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "See all Plan tickets" }));
  await settle();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Keep my Plan ticket draft",
  );
  expect(card.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Close ticket details" }));
  await settle();
  expect(board.scrollLeft).toBe(420);
  expect(document.activeElement).toBe(card);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  bridge.invoke.mockReset();
  localStorage.clear();
  expect(unknownCommands.splice(0)).toEqual([]);
});
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function openPlan(name = "Launch") {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Plan scopes" })).getByRole(
      "button",
      { name: new RegExp(`^${name}(?: \\d+)?$`) },
    ),
  );
  await settle();
}
function chooseView(name: string) {
  fireEvent.click(
    within(screen.getByRole("radiogroup", { name: "Plan view" })).getByRole(
      "radio",
      { name },
    ),
  );
}

test("Plans remember List and Board independently of Dependencies while preserving their header and context", async () => {
  render(<App />);
  await settle();
  await openPlan();
  expect(
    screen.getByRole("radio", { name: "List" }).getAttribute("aria-checked"),
  ).toBe("true");
  chooseView("Board");
  await settle();
  expect(
    screen.getByRole("region", { name: "Ticket status board" }),
  ).toBeTruthy();
  expect(screen.getByText("Ship across projects")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Spec: Release specification" }),
  ).toBeTruthy();
  expect(screen.getByText("1 of 2 done")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add to Plan…" })).toBeTruthy();
  chooseView("Dependencies");
  await settle();
  expect(
    screen.queryByRole("region", { name: "Ticket status board" }),
  ).toBeNull();
  expect(
    JSON.parse(localStorage.getItem("ticketd.preferences")!).ticketLayout,
  ).toBe("board");
  fireEvent.click(screen.getByRole("button", { name: "See all Plan tickets" }));
  await settle();
  expect(
    screen.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"),
  ).toBe("true");
  chooseView("Dependencies");
  await settle();
  await openPlan("Next release");
  expect(
    screen.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: /T-KQ3.*Ticket 3/ })).toBeTruthy();
});

test("a Plan's chosen ticket layout survives restarting the desktop", async () => {
  const first = render(<App />);
  await settle();
  await openPlan();
  chooseView("Board");
  await settle();
  chooseView("Dependencies");
  await settle();
  first.unmount();
  render(<App />);
  await settle();
  await openPlan();
  expect(
    screen.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"),
  ).toBe("true");
  chooseView("List");
  await settle();
  chooseView("Dependencies");
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "See all Plan tickets" }));
  await settle();
  expect(
    screen.getByRole("radio", { name: "List" }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("a cross-project Plan includes parent and subticket cards, pages columns independently, and keeps filtered counts distinct from Plan progress", async () => {
  saved = [
    ...Array.from({ length: 55 }, (_, index) => ticket(index + 1)),
    ticket(200, "Done"),
    ticket(201, "In review", "beta-plan"),
    { ...ticket(202), trashed: true },
  ];
  saved[1] = {
    ...ticket(2),
    parent: { reference: "T-KQ1", title: "Ticket 1", trashed: false },
  };
  render(<App />);
  await settle();
  await openPlan();
  chooseView("Board");
  await settle();
  const board = screen.getByRole("region", { name: "Ticket status board" });
  const todo = within(screen.getByRole("region", { name: "Todo column" }));
  expect(
    within(board)
      .getAllByRole("heading")
      .map((item) => item.textContent),
  ).toEqual([
    "Todo",
    "In progress",
    "In review",
    "Done",
    "Canceled",
    "Duplicate",
  ]);
  expect(todo.getByRole("button", { name: "Show 5 more Todo" })).toBeTruthy();
  const parent = todo.getByRole("button", { name: /^T-KQ1\D/ });
  const child = todo.getByRole("button", { name: /^T-KQ2\D/ });
  expect(within(parent).getByText("Alpha")).toBeTruthy();
  expect(within(child).getByText("Beta")).toBeTruthy();
  expect(within(child).getByText("Subticket of T-KQ1")).toBeTruthy();
  expect(within(parent).queryByText("Launch")).toBeNull();
  expect(
    within(board).queryByRole("button", { name: /^T-KQ201\D/ }),
  ).toBeNull();
  expect(
    within(board).queryByRole("button", { name: /^T-KQ202\D/ }),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /^T-KQ200\D/ },
    ),
  ).toBeTruthy();
  fireEvent.click(todo.getByRole("button", { name: /^Show \d+ more Todo$/ }));
  await settle();
  expect(todo.getAllByRole("button", { name: /^T-/ })).toHaveLength(55);
  expect(
    todo.queryByRole("button", { name: /^Show \d+ more Todo$/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search tickets" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
    target: { value: "Ticket 2" },
  });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  await settle();
  const panel = within(screen.getByRole("dialog", { name: "Ticket filters" }));
  fireEvent.click(panel.getByRole("button", { name: "Todo" }));
  fireEvent.click(panel.getAllByRole("button", { name: "Done" }).at(-1)!);
  await settle();
  expect(todo.getByLabelText("11 matching tickets")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByLabelText(
      "0 matching tickets",
    ),
  ).toBeTruthy();
  expect(screen.getByText("1 of 56 done")).toBeTruthy();
  chooseView("List");
  await settle();
  chooseView("Board");
  await settle();
  expect(
    screen.getByRole("button", { name: "Remove Status is Todo" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Remove Search: Ticket 2" }),
  ).toBeTruthy();
  expect(todo.getByLabelText("11 matching tickets")).toBeTruthy();
});
