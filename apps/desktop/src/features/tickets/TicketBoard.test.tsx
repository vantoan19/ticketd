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
import type { FindFilter, Ticket, TicketSource } from "@/lib/api/client";
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
function external(overrides: Partial<TicketSource> = {}): TicketSource {
  return {
    provider: "github",
    provider_name: "GitHub",
    place: "sample/repo",
    number: "#98",
    id: "98",
    locator: "sample/repo#98",
    display: "sample/repo#98",
    url: "https://github.com/sample/repo/issues/98",
    origin: "imported",
    ownership: "external",
    state: { state: "open" },
    closure_unrecognized: false,
    last_refreshed_at: null,
    last_attempt_at: null,
    last_error: null,
    content_locked: true,
    status_locked: false,
    status_choices: ["Todo", "In progress", "In review"],
    duplicate_target: null,
    ...overrides,
  };
}
let saved: Ticket[];
let change = 0;
let readOverride: ((filter: FindFilter) => Promise<unknown> | null) | null =
  null;
let writeOverride:
  | ((args: {
      references: string[];
      status: string;
      requestId: string;
    }) => Promise<Ticket[]>)
  | null = null;
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
  writeOverride = null;
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: {
        filter?: FindFilter;
        reference?: string;
        references?: string[];
        status?: string;
        requestId?: string;
        patch?: { status?: string };
      },
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
      if (
        command === "change_ticket" &&
        args?.reference &&
        args.patch?.status &&
        args.requestId
      ) {
        const {
          reference,
          patch: { status },
          requestId,
        } = args;
        if (writeOverride)
          return (
            await writeOverride({ references: [reference], status, requestId })
          )[0];
        saved = saved.map((item) =>
          item.reference === reference
            ? { ...item, status, availability: null, duplicate_of: null }
            : item,
        );
        return saved.find((item) => item.reference === reference);
      }
      if (
        command === "bulk_status" &&
        args?.references &&
        args.status &&
        args.requestId
      ) {
        if (
          saved.some(
            (item) =>
              args.references?.includes(item.reference) &&
              item.status === "Duplicate" &&
              args.status !== "Duplicate",
          )
        )
          throw {
            code: "batch_operation",
            index: 0,
            message:
              "Open the duplicate and remove its link before changing its status",
          };
        if (writeOverride)
          return writeOverride({
            references: args.references,
            status: args.status,
            requestId: args.requestId,
          });
        saved = saved.map((item) =>
          args.references?.includes(item.reference)
            ? {
                ...item,
                status: args.status!,
                availability: null,
                duplicate_of: null,
              }
            : item,
        );
        return saved.filter((item) =>
          args.references?.includes(item.reference),
        );
      }
      return bridgeDefault(command, args);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
/** The Layout choice lives in the Display menu; open it when it is closed. */
function layoutRadio(name: "List" | "Board") {
  if (!screen.queryByRole("radio", { name }))
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
  return screen.getByRole("radio", { name });
}
function chooseLayout(name: "List" | "Board") {
  fireEvent.click(layoutRadio(name));
}
async function showBoard() {
  chooseLayout("Board");
  await settle();
}
async function chooseStatus(reference: string, status: string) {
  const trigger = screen.getByRole("button", {
    name: `Change status of ${reference}`,
  });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  await settle();
  fireEvent.click(screen.getByRole("menuitemradio", { name: status }));
  await settle();
}

test("Display holds Layout and Rows; both persist and the header carries no toggles", async () => {
  render(<App />);
  await settle();
  expect(screen.queryByRole("radiogroup", { name: "Layout" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Display" }));
  expect(layoutRadio("List").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Simple" }));
  expect(
    JSON.parse(localStorage.getItem("ticketd.preferences")!).ticketRows,
  ).toBe("simple");
  expect(
    screen.getByRole("radio", { name: "Simple" }).getAttribute("aria-checked"),
  ).toBe("true");
  chooseLayout("Board");
  await settle();
  expect(layoutRadio("Board").getAttribute("aria-checked")).toBe("true");
});

test("Board and List resizing retain independent pane widths without replacing the detail draft", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
  const app = render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /T-1.*Ticket 1/ }));
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Keep this unsaved draft" },
  });
  let separator = screen.getByRole("separator", { name: "Resize ticket list" });
  const size = () => Number(separator.getAttribute("aria-valuenow"));
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  await settle();
  const listSize = size();
  await showBoard();
  expect(size()).toBeCloseTo(44);
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  await settle();
  const boardSize = size();
  expect(boardSize).toBeGreaterThan(44);
  chooseLayout("List");
  await settle();
  expect(size()).toBeCloseTo(listSize);
  await showBoard();
  expect(size()).toBeCloseTo(boardSize);
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Keep this unsaved draft",
  );
  app.unmount();
  render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /T-1.*Ticket 1/ }));
  await settle();
  separator = screen.getByRole("separator", { name: "Resize ticket list" });
  expect(size()).toBeCloseTo(boardSize);
  chooseLayout("List");
  await settle();
  expect(size()).toBeCloseTo(listSize);
});

test("saved-status feedback can be dismissed and does not return after leaving its filtered scope", async () => {
  saved = [ticket(1), ticket(3)];
  render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  await showBoard();
  await chooseStatus("T-1", "In progress");
  const message =
    "T-1 is now In progress. It no longer matches the current filters.";
  const notice = screen.getByText(message).closest('[role="status"]')!;
  expect(
    within(notice as HTMLElement).getByRole("button", {
      name: "Dismiss status update",
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All tickets" }));
  await settle();
  expect(screen.queryByText(message)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  expect(screen.queryByText(message)).toBeNull();
  await chooseStatus("T-3", "In review");
  expect(
    screen.getByText(
      "T-3 is now In review. It no longer matches the current filters.",
    ),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss status update" }),
  );
  expect(
    screen.queryByText(
      "T-3 is now In review. It no longer matches the current filters.",
    ),
  ).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Ticket status board" }),
  );
});

function boardGeometry() {
  const board = screen.getByRole("region", { name: "Ticket status board" });
  vi.spyOn(board, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1680, 600),
  );
  within(board)
    .getAllByRole("region")
    .forEach((column, index) => {
      vi.spyOn(column, "getBoundingClientRect").mockReturnValue(
        new DOMRect(index * 280, 0, 280, 600),
      );
    });
  return board;
}
function startDrag(reference = "T-1", x = 100) {
  const card = screen.getByRole("button", {
    name: new RegExp(`${reference}.*Ticket`),
  });
  card.focus();
  fireEvent.pointerDown(card, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: x,
    clientY: 100,
  });
  return card;
}
function movePointer(x: number, y = 100) {
  fireEvent.pointerMove(window, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: x,
    clientY: y,
  });
}
function releasePointer(x: number, y = 100) {
  fireEvent.pointerUp(window, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: x,
    clientY: y,
  });
}

test("pointer dragging into an empty column saves through the card status action without opening detail", async () => {
  render(<App />);
  await settle();
  await showBoard();
  boardGeometry();
  const card = startDrag();
  movePointer(400);
  expect(
    screen.getByText("Drop to change status to In progress."),
  ).toBeTruthy();
  releasePointer(400);
  // Browsers dispatch a click after pointerup, including after a captured drag.
  fireEvent.click(card, { detail: 1 });
  await settle(20);
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-1",
    patch: { status: "In progress" },
    requestId: expect.any(String),
  });
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(1);
  expect(
    within(
      screen.getByRole("region", { name: "In progress column" }),
    ).getByText("Ticket 1"),
  ).toBeTruthy();
  expect(screen.getByText("T-1 is now In progress.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Close ticket details" }),
  ).toBeNull();
});

test("same-column and outside drops, Escape and pointer cancellation preserve saved state and focus", async () => {
  render(<App />);
  await settle();
  await showBoard();
  boardGeometry();
  const card = startDrag();
  movePointer(140);
  releasePointer(140);
  startDrag();
  movePointer(400);
  releasePointer(400, 700);
  startDrag();
  movePointer(400);
  fireEvent.pointerCancel(window, { pointerId: 1 });
  releasePointer(400);
  startDrag();
  movePointer(400);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(
    screen.queryByText("Drop to change status to In progress."),
  ).toBeNull();
  releasePointer(400);
  await settle();
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
  expect(document.activeElement).toBe(card);
  // A canceled mouse drag must not swallow the next keyboard activation.
  fireEvent.click(card, { detail: 0 });
  await settle();
  expect(
    screen.getByRole("button", { name: "Close ticket details" }),
  ).toBeTruthy();
});

test("a pointer held at the board edge scrolls to offscreen destinations and column contents", async () => {
  render(<App />);
  await settle();
  await showBoard();
  const board = boardGeometry();
  vi.mocked(board.getBoundingClientRect).mockReturnValue(
    new DOMRect(0, 0, 560, 600),
  );
  Object.defineProperties(board, {
    scrollWidth: { configurable: true, value: 1680 },
    clientWidth: { configurable: true, value: 560 },
  });
  const column = screen.getByRole("region", { name: "In progress column" });
  // The column header names the status, so every empty column reads alike and
  // the copy never wraps beside its action.
  expect(within(column).getByText("No tickets")).toBeTruthy();
  const body = column.querySelector<HTMLElement>(".board-column-body")!;
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
    new DOMRect(280, 32, 280, 568),
  );
  Object.defineProperties(body, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 568 },
  });
  startDrag();
  movePointer(550, 590);
  await settle(64);
  expect(board.scrollLeft).toBeGreaterThan(0);
  expect(body.scrollTop).toBeGreaterThan(0);
  fireEvent.keyDown(window, { key: "Escape" });
  const position = board.scrollLeft;
  await settle(64);
  expect(board.scrollLeft).toBe(position);
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
});

test("drag respects external destinations and revalidates source changes made during a drag", async () => {
  saved[0] = { ...ticket(1), source: external() };
  render(<App />);
  await settle();
  await showBoard();
  boardGeometry();
  startDrag();
  movePointer(1000);
  expect(screen.queryByText("Drop to change status to Done.")).toBeNull();
  releasePointer(1000);
  startDrag();
  movePointer(400);
  saved[0] = {
    ...ticket(1, "Done"),
    source: external({ status_choices: [], status_locked: true }),
  };
  releasePointer(400);
  await settle();
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
  expect(screen.getByRole("alert").textContent).toContain(
    "This status is no longer available",
  );
});

test("a pending dragged ticket cannot be dragged again or changed through its menu", async () => {
  let finish: ((value: Ticket[]) => void) | undefined;
  writeOverride = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  render(<App />);
  await settle();
  await showBoard();
  boardGeometry();
  startDrag();
  movePointer(400);
  releasePointer(400);
  await settle();
  startDrag();
  movePointer(1000);
  expect(screen.queryByText("Drop to change status to Done.")).toBeNull();
  releasePointer(1000);
  expect(
    screen.getByRole("button", { name: "Change status of T-1" }),
  ).toHaveProperty("disabled", true);
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(1);
  saved[0] = ticket(1, "In progress");
  finish?.([saved[0]]);
  await settle();
});

test("dropping in Duplicate opens the shared review without moving until confirmation", async () => {
  render(<App />);
  await settle();
  await showBoard();
  boardGeometry();
  startDrag();
  movePointer(1500);
  releasePointer(1500);
  await settle();
  expect(
    screen.getByRole("heading", { name: "Mark T-1 as a duplicate" }),
  ).toBeTruthy();
  expect(saved[0]?.status).toBe("Todo");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle(20);
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByText(
      "Ticket 1",
    ),
  ).toBeTruthy();
});

test("a column empty because of Ready filtering accepts a drag and explains the saved disappearance", async () => {
  render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  await showBoard();
  boardGeometry();
  startDrag();
  movePointer(400);
  releasePointer(400);
  await settle();
  expect(
    screen.getByText(
      "T-1 is now In progress. It no longer matches the current filters.",
    ),
  ).toBeTruthy();
  expect(
    within(
      screen.getByRole("region", { name: "Ticket status board" }),
    ).queryByText("Ticket 1"),
  ).toBeNull();
  expect(screen.getAllByText("No matches")).toHaveLength(6);
});

test("choosing the saved status does not write, and a pending card cannot submit another move", async () => {
  let finish: ((value: Ticket[]) => void) | undefined;
  writeOverride = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Todo");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
  await chooseStatus("T-1", "Done");
  expect(screen.getByText("Saving T-1…")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Change status of T-1" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Change status of T-2" }),
  ).toHaveProperty("disabled", false);
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Change status of T-1" }),
    { key: "Enter" },
  );
  await settle();
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(1);
  await act(async () => {
    saved[0] = { ...ticket(1, "Done"), availability: null };
    finish?.([saved[0]]);
  });
  await settle(20);
  expect(screen.queryByText("Saving T-1…")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Change status of T-1" }),
  );
});

test("a failed save keeps its saved column and retries with the same request identity", async () => {
  let fail = true;
  writeOverride = async ({ status }) => {
    if (fail) throw new Error("Database busy");
    saved[0] = ticket(1, status);
    return [saved[0]];
  };
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Canceled");
  expect(screen.getByRole("alert").textContent).toContain("Database busy");
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  expect(screen.queryByText("T-1 is now Canceled.")).toBeNull();
  fail = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry status change for T-1" }),
  );
  await settle();
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "change_ticket",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]?.[1]).toEqual(writes[0]?.[1]);
  expect(screen.getByText("T-1 is now Canceled.")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Canceled column" })).getByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeTruthy();
});

test("a lost response reconciles applied state and a historical replay never replaces newer saved status", async () => {
  let first = true;
  writeOverride = async () => {
    if (first) {
      first = false;
      saved[0] = ticket(1, "Done");
      throw new Error("Response lost");
    }
    return [ticket(1, "Done")];
  };
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Done");
  expect(screen.getByRole("alert").textContent).toContain(
    "Current saved status: Done",
  );
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  saved[0] = ticket(1, "In review");
  fireEvent.click(
    screen.getByRole("button", { name: "Retry status change for T-1" }),
  );
  await settle();
  expect(screen.getByText("T-1 is now In review.")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "In review column" })).getByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).queryByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeNull();
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "change_ticket",
  );
  expect(writes[1]?.[1]).toEqual(writes[0]?.[1]);
});

test("a successful status save refreshes sidebar counts immediately", async () => {
  const fallback = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command, args) =>
    command === "sidebar_counts"
      ? {
          unread_inbox: 0,
          ready: saved.filter((item) => item.availability === "Ready").length,
          in_progress: saved.filter((item) => item.status === "In progress")
            .length,
        }
      : fallback(command, args),
  );
  render(<App />);
  await settle();
  await showBoard();
  expect(screen.getByRole("button", { name: "In progress 0" })).toBeTruthy();
  await chooseStatus("T-1", "In progress");
  expect(screen.getByRole("button", { name: "In progress 1" })).toBeTruthy();
});

test("card menus honor core status choices, source closure exceptions and retained local provenance", async () => {
  saved = [
    { ...ticket(1), source: external() },
    {
      ...ticket(2),
      source: external({
        state: { state: "closed", reason: "unknown" },
        closure_unrecognized: true,
        status_choices: ["Todo", "Done", "Canceled"],
      }),
    },
    { ...ticket(3), source: external({ ownership: "local" }) },
  ];
  render(<App />);
  await settle();
  await showBoard();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Change status of T-1" }),
    { key: "Enter" },
  );
  await settle();
  expect(
    screen
      .getByRole("menuitemradio", { name: "Done" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(
    screen
      .getByRole("menuitemradio", { name: "In review" })
      .getAttribute("aria-disabled"),
  ).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await settle();
  await chooseStatus("T-2", "Canceled");
  expect(screen.getByText("T-2 is now Canceled.")).toBeTruthy();
  await chooseStatus("T-3", "Done");
  expect(screen.getByText("T-3 is now Done.")).toBeTruthy();
});

test("ownership changes during a card save reconcile the saved state and permitted choices", async () => {
  writeOverride = async () => {
    saved[0] = {
      ...ticket(1, "Done"),
      source: external({
        status_locked: true,
        state: { state: "closed", reason: "completed" },
        status_choices: [],
      }),
    };
    throw new Error("GitHub owns this closure");
  };
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "In progress");
  expect(screen.getByRole("alert").textContent).toContain(
    "Current saved status: Done",
  );
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Change status of T-1" }),
    { key: "Enter" },
  );
  await settle();
  expect(
    screen
      .getByRole("menuitemradio", { name: "In progress" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
});

test("a failed pre-save read offers a working retry without writing stale card data", async () => {
  const fallback = bridge.invoke.getMockImplementation()!;
  let fail = true;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "show_ticket" && fail) throw new Error("Read unavailable");
    return fallback(command, args);
  });
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Done");
  expect(screen.getByRole("alert").textContent).toContain("Read unavailable");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
  fail = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry status change for T-1" }),
  );
  await settle();
  expect(screen.getByText("T-1 is now Done.")).toBeTruthy();
});

test("Duplicate uses the existing review and canceling either duplicate flow preserves saved relationships", async () => {
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Duplicate");
  expect(
    screen.getByRole("heading", { name: "Mark T-1 as a duplicate" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle(20);
  expect(saved[0]?.status).toBe("Todo");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Change status of T-1" }),
  );
  saved[0] = { ...ticket(1, "Duplicate"), duplicate_of: "T-2" };
  change++;
  await settle(2000);
  await chooseStatus("T-1", "Todo");
  expect(
    screen.getByRole("heading", { name: "Remove the duplicate link?" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep duplicate" }));
  await settle(20);
  expect(saved[0]?.duplicate_of).toBe("T-2");
  expect(saved[0]?.status).toBe("Duplicate");
  await chooseStatus("T-1", "Todo");
  fireEvent.click(screen.getByRole("button", { name: "Change status" }));
  await settle();
  expect(saved[0]?.duplicate_of).toBeNull();
  expect(screen.getByText("T-1 is now Todo.")).toBeTruthy();
});

test("a lost duplicate review response reconciles its saved placement before retry", async () => {
  const fallback = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "preview_duplicate_dependencies")
      return {
        source: "T-1",
        canonical: "T-2",
        mode: "duplicate",
        edges: [],
        waiting: [],
        replacement_issues: [],
      };
    if (command === "mark_duplicate_reviewed") {
      saved[0] = { ...ticket(1, "Duplicate"), duplicate_of: "T-2" };
      throw new Error("Duplicate response lost");
    }
    return fallback(command, args);
  });
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Duplicate");
  const input = screen.getByRole("textbox", {
    name: "Canonical ticket reference",
  });
  fireEvent.change(input, { target: { value: "T-2" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Mark duplicate" }));
  await settle();
  expect(screen.getByText("Duplicate response lost")).toBeTruthy();
  const todo = screen.getByRole("region", {
    name: "Todo column",
    hidden: true,
  });
  expect(within(todo).queryByText("Ticket 1")).toBeNull();
  const duplicate = screen.getByRole("region", {
    name: "Duplicate column",
    hidden: true,
  });
  expect(within(duplicate).getByText("Ticket 1")).toBeTruthy();
});

test("a failed source-column refresh cannot keep a reconciled ticket in its previous status", async () => {
  writeOverride = async () => {
    saved[0] = ticket(1, "Done");
    readOverride = (filter) =>
      filter.status === "Todo" ? Promise.reject(new Error("Read busy")) : null;
    throw new Error("Response lost");
  };
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Done");
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).queryByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-1.*Ticket 1/ },
    ),
  ).toBeTruthy();
});

test("a duplicate save stays protected until its reviewed request finishes", async () => {
  const fallback = bridge.invoke.getMockImplementation()!;
  let finish: ((value: Ticket) => void) | undefined;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "preview_duplicate_dependencies")
      return {
        source: "T-1",
        canonical: "T-2",
        mode: "duplicate",
        edges: [],
        waiting: [],
        replacement_issues: [],
      };
    if (command === "mark_duplicate_reviewed")
      return new Promise<Ticket>((resolve) => {
        finish = resolve;
      });
    return fallback(command, args);
  });
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Duplicate");
  const input = screen.getByRole("textbox", {
    name: "Canonical ticket reference",
  });
  fireEvent.change(input, { target: { value: "T-2" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Mark duplicate" }));
  await settle();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await settle();
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => {
    saved[0] = { ...ticket(1, "Duplicate"), duplicate_of: "T-2" };
    finish?.(saved[0]);
  });
  await settle(20);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("T-1 is now Duplicate.")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Change status of T-1" }),
  );
});

test("switching layouts preserves a pending card request and its protection", async () => {
  let finish: ((value: Ticket[]) => void) | undefined;
  writeOverride = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Done");
  chooseLayout("List");
  await settle();
  await showBoard();
  expect(
    screen.getByRole("button", { name: "Change status of T-1" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByText("Saving T-1…")).toBeTruthy();
  await act(async () => {
    saved[0] = ticket(1, "Done");
    finish?.([saved[0]]);
  });
  await settle();
  expect(screen.getByText("T-1 is now Done.")).toBeTruthy();
});

test("a membership response for an old scope cannot announce the wrong filtered outcome", async () => {
  let doneReads = 0;
  let finish: ((value: unknown) => void) | undefined;
  writeOverride = async () => {
    saved[0] = ticket(1, "Done");
    readOverride = (filter) =>
      filter.status === "Done" && ++doneReads === 2
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : null;
    return [saved[0]];
  };
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-1", "Done");
  expect(finish).toBeTypeOf("function");
  fireEvent.click(screen.getByRole("button", { name: /^In progress/ }));
  await settle();
  await act(async () => {
    finish?.([{ ticket: saved[0], latest_update: null }]);
  });
  await settle();
  expect(
    screen.getByText(
      "T-1 is now Done. It no longer matches the current filters.",
    ),
  ).toBeTruthy();
});

test("a move out of Ready keeps its filters, announces departure and focuses the board", async () => {
  render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  await showBoard();
  await chooseStatus("T-1", "In progress");
  expect(screen.queryByRole("button", { name: /T-1.*Ticket 1/ })).toBeNull();
  expect(
    screen.getByText(
      "T-1 is now In progress. It no longer matches the current filters.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Ready", level: 1 })).toBeTruthy();
  await settle(20);
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Ticket status board" }),
  );
});

test("a card status action changes only that ticket and leaves the selected detail draft intact", async () => {
  saved = [
    {
      ...ticket(1),
      children: [{ reference: "T-3", title: "Ticket 3", trashed: false }],
    },
    ticket(2, "In review"),
    {
      ...ticket(3),
      parent: { reference: "T-1", title: "Ticket 1", trashed: false },
    },
  ];
  render(<App />);
  await settle();
  await showBoard();
  fireEvent.click(screen.getByRole("button", { name: /T-2.*Ticket 2/ }));
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Keep my draft" },
  });
  const action = screen.getByRole("button", { name: "Change status of T-1" });
  fireEvent.keyDown(action, { key: "Enter" });
  await settle();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "In progress" }));
  await settle();
  expect(
    within(
      screen.getByRole("region", { name: "In progress column" }),
    ).getByRole("button", { name: /T-1.*Ticket 1/ }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-3.*Ticket 3/ },
    ),
  ).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Keep my draft",
  );
  expect(screen.getByText("T-1 is now In progress.")).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-1",
    patch: { status: "In progress" },
    requestId: expect.any(String),
  });
});

test("List is the default and Board keeps all six columns, including empty statuses", async () => {
  render(<App />);
  await settle();
  expect(layoutRadio("List").getAttribute("aria-checked")).toBe("true");
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
      "No tickets",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: "Add ticket" },
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
  expect(progress.getAllByRole("button", { name: /^T-\d+/ })).toHaveLength(128);
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
      { name: /^T-d+/ },
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
  chooseLayout("List");
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
      { name: /^T-d+/ },
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
  expect(layoutRadio("Board").getAttribute("aria-checked")).toBe("true");
  expect(
    within(screen.getByRole("region", { name: "Done column" })).queryByRole(
      "button",
      { name: /^T-d+/ },
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  await settle();
  expect(screen.queryByRole("button", { name: "Display" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All tickets" }));
  await settle();
  expect(layoutRadio("Board").getAttribute("aria-checked")).toBe("true");
  first.unmount();
  render(<App />);
  await settle();
  expect(layoutRadio("Board").getAttribute("aria-checked")).toBe("true");
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
  // A Plan takes its layout from its header, so Display offers only Rows.
  fireEvent.click(screen.getByRole("button", { name: "Display" }));
  expect(screen.getByRole("radiogroup", { name: "Rows" })).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Layout" })).toBeNull();
});
