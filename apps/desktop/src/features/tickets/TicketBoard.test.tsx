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

function ticket(id: number, status = "Todo"): Ticket {
  return {
    id: String(id),
    reference: `T-${id}`,
    title: `Ticket ${id}`,
    body: "",
    status,
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: status === "Todo" ? "Ready" : null,
    parent: null,
    children: [],
    prerequisites: [],
  };
}
let saved: Ticket[];
let change = 0;
let readOverride: ((filter: FindFilter) => Promise<unknown> | null) | null =
  null;
function matching(filter: FindFilter) {
  return saved.filter(
    (item) =>
      (!filter.status || item.status === filter.status) &&
      (!filter.query || item.title.includes(filter.query)) &&
      (!filter.availability || item.availability === filter.availability) &&
      (!filter.project || item.project_id === filter.project) &&
      (!filter.unlinked || item.project_id === null) &&
      (!filter.plan || item.plan_id === filter.plan) &&
      (!filter.family || item.parent?.reference === filter.family) &&
      filter.tags.every((tag) => item.tags.includes(tag)),
  );
}
function counts(items: Ticket[]) {
  return {
    total: items.length,
    todo: items.filter((t) => t.status === "Todo").length,
    in_progress: items.filter((t) => t.status === "In progress").length,
    in_review: items.filter((t) => t.status === "In review").length,
    done: items.filter((t) => t.status === "Done").length,
    canceled: items.filter((t) => t.status === "Canceled").length,
    duplicate: items.filter((t) => t.status === "Duplicate").length,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  saved = [ticket(1), ticket(2, "In review")];
  change = 0;
  readOverride = null;
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { filter?: FindFilter; reference?: string },
    ) => {
      if (command === "workspace_change_token") return change;
      if (command === "list_projects")
        return [
          {
            id: "project",
            name: "Sample project",
            path: "/sample",
            paths: ["/sample"],
          },
        ];
      if (command === "list_plans")
        return [
          { id: "plan", name: "Release plan", archived: false, purpose: "" },
        ];
      if (command === "find_tickets_with_updates" && args?.filter) {
        const override = readOverride?.(args.filter);
        if (override) return override;
        const { offset, limit } = args.filter;
        if (limit > 50)
          throw new Error("Desktop search batches must remain bounded");
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
async function showBoard() {
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  await settle();
}

test("List is the default and Board keeps all six columns, including empty statuses", async () => {
  render(<App />);
  await settle();
  expect(
    screen.getByRole("radio", { name: "List" }).getAttribute("aria-checked"),
  ).toBe("true");
  await showBoard();
  const board = screen.getByRole("region", { name: "Ticket status board" });
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
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "In review column" })).getByRole(
      "button",
      { name: /T-2.*Ticket 2/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByText(
      "No matching tickets",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Counts reflect current filters.")).toBeTruthy();
});

test("each status loads a bounded page with accurate totals and its own Load more", async () => {
  saved = [
    ...Array.from({ length: 128 }, (_, i) => ticket(i + 1, "In progress")),
    ticket(129),
    ticket(130, "Done"),
  ];
  render(<App />);
  await settle();
  await showBoard();
  const progress = within(
    screen.getByRole("region", { name: "In progress column" }),
  );
  expect(progress.getByText("50 of 128 loaded")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-129.*Ticket 129/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-130.*Ticket 130/ },
    ),
  ).toBeTruthy();
  fireEvent.click(
    progress.getByRole("button", { name: "Load more In progress" }),
  );
  await settle();
  expect(progress.getByText("100 of 128 loaded")).toBeTruthy();
  fireEvent.click(
    progress.getByRole("button", { name: "Load more In progress" }),
  );
  await settle();
  expect(progress.getAllByRole("button")).toHaveLength(128);
  expect(
    progress.queryByRole("button", { name: "Load more In progress" }),
  ).toBeNull();
});

test("an obsolete Load more response cannot put tickets back into a different scope", async () => {
  saved = [
    ...Array.from({ length: 55 }, (_, i) => ticket(i + 1)),
    ticket(56, "In progress"),
  ];
  render(<App />);
  await settle();
  await showBoard();
  let finish: ((value: unknown) => void) | undefined;
  readOverride = (filter) =>
    filter.status === "Todo" && filter.offset === 50
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : null;
  fireEvent.click(screen.getByRole("button", { name: "Load more Todo" }));
  await settle();
  expect(finish).toBeTypeOf("function");
  fireEvent.click(screen.getByRole("button", { name: /^In progress/ }));
  await settle();
  await act(async () => {
    finish?.(
      saved.slice(50, 55).map((ticket) => ({ ticket, latest_update: null })),
    );
  });
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).queryByRole(
      "button",
    ),
  ).toBeNull();
  expect(screen.getByRole("button", { name: /T-56.*Ticket 56/ })).toBeTruthy();
});

test("workspace changes reconcile cards, counts and selected detail while a failed column refresh preserves saved cards", async () => {
  render(<App />);
  await settle();
  await showBoard();
  fireEvent.click(screen.getByRole("button", { name: /T-1.*Ticket 1/ }));
  await settle();
  saved = [
    { ...ticket(1), title: "Updated elsewhere" },
    ticket(2, "Done"),
    ticket(3, "In progress"),
  ];
  readOverride = (filter) =>
    filter.status === "Todo"
      ? Promise.reject(new Error("Database busy"))
      : null;
  change++;
  await settle(2000);
  const todo = within(screen.getByRole("region", { name: "Todo column" }));
  expect(todo.getByRole("button", { name: /T-1.*Ticket 1/ })).toBeTruthy();
  expect(todo.getByText(/information may be stale/)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Updated elsewhere",
  );
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-2.*Ticket 2/ },
    ),
  ).toBeTruthy();
  expect(
    within(
      screen.getByRole("region", { name: "In progress column" }),
    ).getByLabelText("1 matching tickets"),
  ).toBeTruthy();
  readOverride = null;
  fireEvent.click(todo.getByRole("button", { name: "Retry" }));
  await settle();
  expect(
    todo.getByRole("button", { name: /T-1.*Updated elsewhere/ }),
  ).toBeTruthy();
  expect(todo.queryByText(/information may be stale/)).toBeNull();
});

test("a card outside the List page opens existing detail, preserves its draft across layouts, and restores focus", async () => {
  saved = [
    ...Array.from({ length: 55 }, (_, i) => ticket(i + 1, "In progress")),
    ticket(56),
  ];
  render(<App />);
  await settle();
  await showBoard();
  const card = screen.getByRole("button", { name: /T-56.*Ticket 56/ });
  card.focus();
  fireEvent.click(card);
  await settle();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Ticket 56",
  );
  expect(screen.queryByText(/outside the current results/i)).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Unpublished draft" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  await settle();
  await showBoard();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Unpublished draft",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close ticket details" }));
  await settle();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /T-56.*Ticket 56/ }),
  );
});

test("layout preference survives navigation and restart while search and status filters remain visible", async () => {
  saved = [ticket(1), ticket(2, "Done")];
  const first = render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  await settle();
  fireEvent.click(screen.getAllByRole("button", { name: "Done" })[0]!);
  // The panel's Done button closes it; the status chip is also named Done.
  const panel = screen.getByRole("dialog", { name: "Ticket filters" });
  fireEvent.click(
    within(panel).getAllByRole("button", { name: "Done" }).at(-1)!,
  );
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Search tickets" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
    target: { value: "Ticket 2" },
  });
  await settle();
  await showBoard();
  expect(
    screen.getByRole("button", { name: "Remove Status is Done" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Remove Search: Ticket 2" }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).queryByRole(
      "button",
    ),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-2.*Ticket 2/ },
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  expect(
    screen.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    within(screen.getByRole("region", { name: "Done column" })).queryByRole(
      "button",
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  await settle();
  expect(
    screen.queryByRole("radiogroup", { name: "Ticket layout" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All tickets" }));
  await settle();
  expect(
    screen.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"),
  ).toBe("true");
  first.unmount();
  render(<App />);
  await settle();
  expect(
    screen.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("cards retain source, project, Plan and core readiness context; project and No project scopes reuse the board", async () => {
  const blocked = {
    ...ticket(1),
    availability: "Blocked",
    project_id: "project",
    plan_id: "plan",
    prerequisites: [
      {
        reference: "T-4",
        title: "Review pending",
        status: "In review",
        trashed: false,
        unresolved: true,
      },
    ],
  };
  const child = {
    ...ticket(3),
    parent: { reference: "T-1", title: "Parent outcome", trashed: false },
  };
  const unavailable = {
    ...ticket(5),
    source: {
      provider: "github",
      provider_name: "GitHub",
      place: "sample/repo",
      number: "#98",
      id: "98",
      locator: "sample/repo#98",
      display: "sample/repo#98",
      url: "https://github.com/sample/repo/issues/98",
      origin: "imported" as const,
      ownership: "external" as const,
      state: { state: "open" as const },
      closure_unrecognized: false,
      last_refreshed_at: null,
      last_attempt_at: null,
      last_error: null,
      content_locked: true,
      status_locked: false,
      status_choices: [
        "Todo" as const,
        "In progress" as const,
        "In review" as const,
      ],
      duplicate_target: null,
      unavailable: {
        code: "missing",
        message: "Not found",
        since: "2026-11-06T00:00:00Z",
      },
    },
  };
  saved = [
    blocked,
    { ...ticket(2, "In progress"), availability: "Ready" },
    child,
    ticket(4, "In review"),
    unavailable,
  ];
  render(<App />);
  await settle();
  await showBoard();
  const card = screen.getByRole("button", { name: /T-1.*Ticket 1/ });
  expect(within(card).getByText("Blocked by T-4")).toBeTruthy();
  expect(within(card).getByText("Sample project")).toBeTruthy();
  expect(within(card).getByText("Release plan")).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: /T-2.*Ticket 2/ })).queryByText(
      "Ready",
    ),
  ).toBeNull();
  expect(
    within(screen.getByRole("button", { name: /T-3.*Ticket 3/ })).getByText(
      "Subticket of T-1",
    ),
  ).toBeTruthy();
  const sourceCard = screen.getByRole("button", { name: /T-5.*Ticket 5/ });
  expect(within(sourceCard).getByText("Source unavailable")).toBeTruthy();
  expect(within(sourceCard).getByText(/Owned by GitHub/)).toBeTruthy();
  expect(within(sourceCard).queryByText("Ready")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sample project" }));
  await settle();
  expect(screen.getByRole("button", { name: /T-1.*Ticket 1/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /T-3.*Ticket 3/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "No project" }));
  await settle();
  expect(screen.queryByRole("button", { name: /T-1.*Ticket 1/ })).toBeNull();
  expect(screen.getByRole("button", { name: /T-3.*Ticket 3/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Release plan" }));
  await settle();
  expect(
    screen.queryByRole("radiogroup", { name: "Ticket layout" }),
  ).toBeNull();
});
