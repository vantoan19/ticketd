// @vitest-environment jsdom
import { chooseFilter } from "@/test/filters";
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
    reference: `T-KQ${id}`,
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
        args.patch?.status
      ) {
        const {
          reference,
          patch: { status },
          requestId,
        } = args;
        if (writeOverride)
          return (
            await writeOverride({
              references: [reference],
              status,
              requestId: requestId ?? "palette",
            })
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
    name: new RegExp(`^Change status of ${reference}, current status:`),
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
  fireEvent.click(screen.getByRole("radio", { name: "Detailed" }));
  fireEvent.click(screen.getByRole("radio", { name: "One line" }));
  expect(
    JSON.parse(localStorage.getItem("ticketd.preferences")!).ticketRows,
  ).toBe("simple");
  expect(
    screen
      .getByRole("radio", { name: "One line" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  chooseLayout("Board");
  await settle();
  expect(layoutRadio("Board").getAttribute("aria-checked")).toBe("true");
});

test("an open card peeks over the board, which keeps its width, and the list split survives", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
  render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*Ticket 1/ }));
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Keep this unsaved draft" },
  });
  const separator = () =>
    screen.queryByRole("separator", { name: "Resize ticket list" });
  const size = () => Number(separator()?.getAttribute("aria-valuenow"));
  fireEvent.keyDown(separator()!, { key: "ArrowRight" });
  await settle();
  const listSize = size();
  await showBoard();
  // The open card is a peek over the board: no split to resize (S5).
  expect(
    document.querySelector(".ticket-workspace")?.hasAttribute("data-peek"),
  ).toBe(true);
  // Escape closes the peek (a first one may close an open tooltip).
  for (let press = 0; press < 2; press++)
    fireEvent.keyDown(document.getElementById("detail-heading")!, {
      key: "Escape",
    });
  await settle();
  expect(
    document.querySelector(".ticket-workspace")?.hasAttribute("data-peek"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*Ticket 1/ }));
  await settle();
  chooseLayout("List");
  await settle();
  expect(size()).toBeCloseTo(listSize);
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Keep this unsaved draft",
  );
});

test("saved-status feedback is the pane's status line, can be dismissed and does not return", async () => {
  saved = [ticket(1), ticket(3)];
  render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  await showBoard();
  const board = screen.getByRole("region", { name: "Ticket status board" });
  const top = board.getBoundingClientRect().top;
  await chooseStatus("T-KQ1", "In progress");
  const message =
    "Moved T-KQ1 to In progress. It no longer matches the filters";
  const notice = screen.getByText(message).closest('[role="status"]')!;
  // Nothing is inserted above the columns (list B-04): the line floats.
  expect(notice.getAttribute("data-slot")).toBe("status-line");
  expect(board.getBoundingClientRect().top).toBe(top);
  fireEvent.click(
    within(notice as HTMLElement).getByRole("button", { name: "Dismiss" }),
  );
  expect(screen.queryByText(message)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All tickets" }));
  await settle();
  expect(screen.queryByText(message)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  expect(screen.queryByText(message)).toBeNull();
  await chooseStatus("T-KQ3", "In review");
  expect(
    screen.getByText(
      "Moved T-KQ3 to In review. It no longer matches the filters",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(
    screen.queryByText(
      "Moved T-KQ3 to In review. It no longer matches the filters",
    ),
  ).toBeNull();
  // Closing the line keeps focus in the pane, never on the page.
  expect(document.activeElement?.closest(".ticket-list")).toBeTruthy();
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
function startDrag(reference = "T-KQ1", x = 100) {
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
    reference: "T-KQ1",
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
  expect(screen.getByText("Moved T-KQ1 to In progress")).toBeTruthy();
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
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByText(
      "Can't move here",
    ),
  ).toBeTruthy();
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
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
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
    screen.getByRole("heading", { name: "Mark T-KQ1 as a duplicate" }),
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
      "Moved T-KQ1 to In progress. It no longer matches the filters",
    ),
  ).toBeTruthy();
  // Nothing left: one empty state for the view, not six empty columns.
  const list = document.querySelector<HTMLElement>(".ticket-list")!;
  expect(within(list).queryByText("Ticket 1")).toBeNull();
  expect(within(list).getByText("No Ready tickets")).toBeTruthy();
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
  await chooseStatus("T-KQ1", "Todo");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
  await chooseStatus("T-KQ1", "Done");
  expect(screen.getByText("Saving…")).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", {
      name: /^Change status of T-KQ2, current status:/,
    }),
  ).toHaveProperty("disabled", false);
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
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
  expect(screen.queryByText("Saving…")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
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
  boardGeometry();
  startDrag();
  movePointer(1200);
  releasePointer(1200);
  await settle();
  expect(screen.getByRole("alert").textContent).toContain("Database busy");
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Moved T-KQ1 to Canceled")).toBeNull();
  fail = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry status change for T-KQ1" }),
  );
  await settle();
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "change_ticket",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]?.[1]).toEqual(writes[0]?.[1]);
  expect(screen.getByText("Moved T-KQ1 to Canceled")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Canceled column" })).getByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
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
  await chooseStatus("T-KQ1", "Done");
  expect(screen.getByRole("alert").textContent).toContain("It is now Done.");
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  saved[0] = ticket(1, "In review");
  fireEvent.click(
    screen.getByRole("button", { name: "Retry status change for T-KQ1" }),
  );
  await settle();
  expect(screen.getByText("Moved T-KQ1 to In review")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "In review column" })).getByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).queryByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
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
  expect(screen.getByRole("button", { name: "In progress" })).toBeTruthy();
  await chooseStatus("T-KQ1", "In progress");
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
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
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
  await chooseStatus("T-KQ2", "Canceled");
  expect(screen.getByText("Moved T-KQ2 to Canceled")).toBeTruthy();
  await chooseStatus("T-KQ3", "Done");
  expect(screen.getByText("Moved T-KQ3 to Done")).toBeTruthy();
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
  await chooseStatus("T-KQ1", "In progress");
  expect(screen.getByRole("alert").textContent).toContain("It is now Done.");
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
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
  await chooseStatus("T-KQ1", "Done");
  expect(screen.getByRole("alert").textContent).toContain("Read unavailable");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "change_ticket"),
  ).toHaveLength(0);
  fail = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry status change for T-KQ1" }),
  );
  await settle();
  expect(screen.getByText("Moved T-KQ1 to Done")).toBeTruthy();
});

test("Duplicate uses the existing review and canceling either duplicate flow preserves saved relationships", async () => {
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-KQ1", "Duplicate");
  expect(
    screen.getByRole("heading", { name: "Mark T-KQ1 as a duplicate" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle(20);
  expect(saved[0]?.status).toBe("Todo");
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
  );
  saved[0] = { ...ticket(1, "Duplicate"), duplicate_of: "T-KQ2" };
  change++;
  await settle(2000);
  await chooseStatus("T-KQ1", "Todo");
  expect(
    screen.getByRole("heading", { name: "Change the status to Todo?" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep duplicate" }));
  await settle(20);
  expect(saved[0]?.duplicate_of).toBe("T-KQ2");
  expect(saved[0]?.status).toBe("Duplicate");
  await chooseStatus("T-KQ1", "Todo");
  fireEvent.click(screen.getByRole("button", { name: "Change status" }));
  await settle();
  expect(saved[0]?.duplicate_of).toBeNull();
  expect(screen.getByText("Moved T-KQ1 to Todo")).toBeTruthy();
});

test("a lost duplicate review response reconciles its saved placement before retry", async () => {
  const fallback = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "preview_duplicate_dependencies")
      return {
        source: "T-KQ1",
        canonical: "T-KQ2",
        mode: "duplicate",
        edges: [],
        waiting: [],
        replacement_issues: [],
      };
    if (command === "mark_duplicate_reviewed") {
      saved[0] = { ...ticket(1, "Duplicate"), duplicate_of: "T-KQ2" };
      throw new Error("Duplicate response lost");
    }
    return fallback(command, args);
  });
  render(<App />);
  await settle();
  await showBoard();
  await chooseStatus("T-KQ1", "Duplicate");
  const input = screen.getByRole("textbox", {
    name: "Canonical ticket reference",
  });
  fireEvent.change(input, { target: { value: "T-KQ2" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Mark duplicate" }));
  await settle();
  expect(screen.getByText(/Duplicate response lost\./)).toBeTruthy();
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
  await chooseStatus("T-KQ1", "Done");
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).queryByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
    ),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
    ),
  ).toBeTruthy();
});

test("a duplicate save stays protected until its reviewed request finishes", async () => {
  const fallback = bridge.invoke.getMockImplementation()!;
  let finish: ((value: Ticket) => void) | undefined;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "preview_duplicate_dependencies")
      return {
        source: "T-KQ1",
        canonical: "T-KQ2",
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
  await chooseStatus("T-KQ1", "Duplicate");
  const input = screen.getByRole("textbox", {
    name: "Canonical ticket reference",
  });
  fireEvent.change(input, { target: { value: "T-KQ2" } });
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
    saved[0] = { ...ticket(1, "Duplicate"), duplicate_of: "T-KQ2" };
    finish?.(saved[0]);
  });
  await settle(20);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Moved T-KQ1 to Duplicate")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
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
  await chooseStatus("T-KQ1", "Done");
  chooseLayout("List");
  await settle();
  await showBoard();
  expect(
    screen.getByRole("button", {
      name: /^Change status of T-KQ1, current status:/,
    }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByText("Saving…")).toBeTruthy();
  await act(async () => {
    saved[0] = ticket(1, "Done");
    finish?.([saved[0]]);
  });
  await settle();
  expect(screen.getByText("Moved T-KQ1 to Done")).toBeTruthy();
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
  await chooseStatus("T-KQ1", "Done");
  expect(finish).toBeTypeOf("function");
  fireEvent.click(screen.getByRole("button", { name: /^In progress/ }));
  await settle();
  await act(async () => {
    finish?.([{ ticket: saved[0], latest_update: null }]);
  });
  await settle();
  expect(
    screen.getByText("Moved T-KQ1 to Done. It no longer matches the filters"),
  ).toBeTruthy();
});

test("a move out of Ready keeps its filters, announces departure and focuses the board", async () => {
  render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  await showBoard();
  await chooseStatus("T-KQ1", "In progress");
  expect(screen.queryByRole("button", { name: /T-KQ1.*Ticket 1/ })).toBeNull();
  expect(
    screen.getByText(
      "Moved T-KQ1 to In progress. It no longer matches the filters",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Ready", level: 1 })).toBeTruthy();
  await settle(20);
  expect(document.activeElement?.closest(".ticket-list")).toBeTruthy();
});

test("a card status action changes only that ticket and leaves the selected detail draft intact", async () => {
  saved = [
    {
      ...ticket(1),
      children: [{ reference: "T-KQ3", title: "Ticket 3", trashed: false }],
    },
    ticket(2, "In review"),
    {
      ...ticket(3),
      parent: { reference: "T-KQ1", title: "Ticket 1", trashed: false },
    },
  ];
  render(<App />);
  await settle();
  await showBoard();
  fireEvent.click(screen.getByRole("button", { name: /T-KQ2.*Ticket 2/ }));
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Keep my draft" },
  });
  const action = screen.getByRole("button", {
    name: /^Change status of T-KQ1, current status:/,
  });
  fireEvent.keyDown(action, { key: "Enter" });
  await settle();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "In progress" }));
  await settle();
  expect(
    within(
      screen.getByRole("region", { name: "In progress column" }),
    ).getByRole("button", { name: /T-KQ1.*Ticket 1/ }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-KQ3.*Ticket 3/ },
    ),
  ).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Keep my draft",
  );
  expect(screen.getByText("Moved T-KQ1 to In progress")).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-KQ1",
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
  ).toEqual(["Todo", "In progress", "In review", "Done"]);
  // Canceled and Duplicate fold to 40px headers that open them (S5).
  fireEvent.click(screen.getByRole("button", { name: /^Show Canceled/ }));
  expect(within(board).getByRole("heading", { name: "Canceled" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Show Duplicate/ })).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-KQ1.*Ticket 1/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "In review column" })).getByRole(
      "button",
      { name: /T-KQ2.*Ticket 2/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByText(
      "No tickets",
    ),
  ).toBeTruthy();
  // One muted line; Add lives in the column header (BD-06).
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: "Add Done ticket" },
    ),
  ).toBeTruthy();
  // The footer note shows only while filters narrow the columns (BD-04).
  expect(screen.queryByText("Counts reflect current filters.")).toBeNull();
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
  // The total is in the column header; the pager names the next page (P17).
  expect(progress.getAllByRole("button", { name: /^T-KQ\d+/ })).toHaveLength(
    50,
  );
  expect(
    progress.getByRole("button", { name: "Show 50 more In progress" }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByRole(
      "button",
      { name: /T-KQ129.*Ticket 129/ },
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-KQ130.*Ticket 130/ },
    ),
  ).toBeTruthy();
  fireEvent.click(
    progress.getByRole("button", { name: /^Show \d+ more In progress$/ }),
  );
  await settle();
  expect(progress.getAllByRole("button", { name: /^T-KQ\d+/ })).toHaveLength(
    100,
  );
  expect(
    progress.getByRole("button", { name: "Show 28 more In progress" }),
  ).toBeTruthy();
  fireEvent.click(
    progress.getByRole("button", { name: /^Show \d+ more In progress$/ }),
  );
  await settle();
  expect(progress.getAllByRole("button", { name: /^T-KQ\d+/ })).toHaveLength(
    128,
  );
  expect(
    progress.queryByRole("button", { name: /^Show \d+ more In progress$/ }),
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
  fireEvent.click(screen.getByRole("button", { name: /^Show \d+ more Todo$/ }));
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
      { name: /^T-KQd+/ },
    ),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: /T-KQ56.*Ticket 56/ }),
  ).toBeTruthy();
});

test("workspace changes reconcile cards, counts and selected detail while a failed column refresh preserves saved cards", async () => {
  render(<App />);
  await settle();
  await showBoard();
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*Ticket 1/ }));
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
  expect(todo.getByRole("button", { name: /T-KQ1.*Ticket 1/ })).toBeTruthy();
  expect(todo.getByText(/Showing the saved tickets/)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Updated elsewhere",
  );
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-KQ2.*Ticket 2/ },
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
    todo.getByRole("button", { name: /T-KQ1.*Updated elsewhere/ }),
  ).toBeTruthy();
  expect(todo.queryByText(/Showing the saved tickets/)).toBeNull();
});

test("a card outside the List page opens existing detail, preserves its draft across layouts, and restores focus", async () => {
  saved = [
    ...Array.from({ length: 55 }, (_, i) => ticket(i + 1, "In progress")),
    ticket(56),
  ];
  render(<App />);
  await settle();
  await showBoard();
  const card = screen.getByRole("button", { name: /T-KQ56.*Ticket 56/ });
  const board = screen.getByRole("region", { name: "Ticket status board" });
  board.scrollLeft = 320;
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
    screen.getByRole("button", { name: /T-KQ56.*Ticket 56/ }),
  );
  expect(
    screen.getByRole("region", { name: "Ticket status board" }).scrollLeft,
  ).toBe(320);
});

test("closing a ticket followed within Board details returns to its card", async () => {
  saved = [{ ...ticket(1), body: "See T-KQ2." }, ticket(2)];
  render(<App />);
  await settle();
  await showBoard();
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*Ticket 1/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "T-KQ2" }));
  await settle();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Ticket 2",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close ticket details" }));
  await settle();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /T-KQ2.*Ticket 2/ }),
  );
});

test("layout preference survives navigation and restart while status filters remain visible", async () => {
  saved = [ticket(1), ticket(2, "Done")];
  const first = render(<App />);
  await settle();
  await chooseFilter("Status", "Done");
  await settle();
  await settle();
  await showBoard();
  expect(
    screen.getByRole("button", { name: "Remove Status filter" }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).queryByRole(
      "button",
      { name: /^T-KQd+/ },
    ),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByRole(
      "button",
      { name: /T-KQ2.*Ticket 2/ },
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  expect(layoutRadio("Board").getAttribute("aria-checked")).toBe("true");
  expect(
    within(screen.getByRole("region", { name: "Done column" })).queryByRole(
      "button",
      { name: /^T-KQd+/ },
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
        reference: "T-KQ4",
        title: "Review pending",
        status: "In review",
        trashed: false,
        unresolved: true,
      },
    ],
  };
  const child = {
    ...ticket(3),
    parent: { reference: "T-KQ1", title: "Parent outcome", trashed: false },
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
  const card = screen.getByRole("button", { name: /T-KQ1.*Ticket 1/ });
  expect(within(card).getByText("Blocked by T-KQ4")).toBeTruthy();
  // One context item, as on a list row (BD-07): the Plan before the project.
  expect(within(card).getByText("Release plan")).toBeTruthy();
  expect(within(card).queryByText("Sample project")).toBeNull();
  expect(
    within(screen.getByRole("button", { name: /T-KQ2.*Ticket 2/ })).queryByText(
      "Ready",
    ),
  ).toBeNull();
  expect(
    within(screen.getByRole("button", { name: /T-KQ3.*Ticket 3/ })).getByText(
      "Subticket of T-KQ1",
    ),
  ).toBeTruthy();
  const sourceCard = screen.getByRole("button", { name: /T-KQ5.*Ticket 5/ });
  expect(within(sourceCard).getByText("Source unavailable")).toBeTruthy();
  expect(within(sourceCard).getByText(/Owned by GitHub/)).toBeTruthy();
  expect(within(sourceCard).queryByText("Ready")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sample project" }));
  await settle();
  expect(screen.getByRole("button", { name: /T-KQ1.*Ticket 1/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /T-KQ3.*Ticket 3/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "No project" }));
  await settle();
  expect(screen.queryByRole("button", { name: /T-KQ1.*Ticket 1/ })).toBeNull();
  expect(screen.getByRole("button", { name: /T-KQ3.*Ticket 3/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Release plan" }));
  await settle();
  // A Plan takes its layout from its header; More opens Display for Rows.
  fireEvent.keyDown(screen.getByRole("button", { name: "Plan actions" }), {
    key: "Enter",
  });
  await settle();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Filter and display…" }),
  );
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Display" }));
  expect(screen.getByRole("radiogroup", { name: "Rows" })).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Layout" })).toBeNull();
});

test("a board card says Needs review in place of its readiness", async () => {
  const defaults = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args?: unknown) =>
    command === "sync_conflicts"
      ? [
          {
            kind: "ticket",
            id: "1",
            reference: "T-KQ1",
            title: "Ticket 1",
            fields: ["status"],
            detected_at: "2026-11-11T18:41:00Z",
            read: false,
          },
        ]
      : defaults(command, args),
  );
  saved = [ticket(1), ticket(3)];
  render(<App />);
  await settle();
  await showBoard();
  const card = (reference: string) =>
    document.querySelector(`[data-board-reference="${reference}"]`);
  expect(card("T-KQ1")?.textContent).toContain("Needs review");
  expect(card("T-KQ1")?.textContent).not.toContain("Ready");
  // Ready is the Todo column's norm, so a card flags only Blocked.
  expect(card("T-KQ3")?.textContent).not.toContain("Ready");
  expect(card("T-KQ3")?.textContent).not.toContain("Needs review");
});

test("board cards and their status actions announce the current status once", async () => {
  render(<App />);
  await settle();
  await showBoard();
  expect(
    screen.getByRole("button", { name: "T-KQ2 In review Ticket 2" }),
  ).toBeTruthy();
  const trigger = screen.getByRole("button", {
    name: "Change status of T-KQ2, current status: In review",
  });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  await settle();
  expect(screen.getByRole("menuitemradio", { name: "In review" })).toBeTruthy();
  expect(within(screen.getByRole("menu")).queryByRole("img")).toBeNull();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Done" }));
  await settle(20);
  expect(
    screen.getByRole("button", { name: "T-KQ2 Done Ticket 2" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Change status of T-KQ2, current status: Done",
    }),
  ).toBeTruthy();
});

test("a folded destination stays folded through a deferred save, preserves the measured slot and unfolds only after confirmation", async () => {
  let resolve!: () => void;
  writeOverride = async ({ status }) => {
    await new Promise<void>((done) => {
      resolve = done;
    });
    saved[0] = ticket(1, status);
    return [saved[0]];
  };
  render(<App />);
  await settle();
  await showBoard();
  boardGeometry();
  const container = document.querySelector<HTMLElement>(
    '[data-ticket-reference="T-KQ1"]',
  )!;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 240, 126),
  );
  startDrag();
  movePointer(1200);
  const canceled = screen.getByRole("region", { name: "Canceled column" });
  expect(canceled.hasAttribute("data-folded")).toBe(true);
  releasePointer(1200);
  await settle();
  expect(canceled.hasAttribute("data-folded")).toBe(true);
  expect(within(canceled).getByText("Saving…")).toBeTruthy();
  expect(
    document.querySelector<HTMLElement>("[data-board-slot]")?.style.height,
  ).toBe("126px");
  resolve();
  await settle();
  expect(canceled.hasAttribute("data-folded")).toBe(false);
  await settle(160);
  expect(document.querySelector("[data-board-slot]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await settle();
  resolve();
  await settle();
  expect(
    within(screen.getByRole("region", { name: "Todo column" })).getByText(
      "Ticket 1",
    ),
  ).toBeTruthy();
});

test("board arrows reach adjacent cards and S opens the shared status drill for the focused card", async () => {
  saved.push(ticket(3));
  render(<App />);
  await settle();
  await showBoard();
  const first = screen.getByRole("button", { name: /T-KQ1.*Ticket 1/ });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toContain("T-KQ3");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement?.textContent).toContain("T-KQ2");
  fireEvent.keyDown(document.activeElement!, { key: "s" });
  await settle();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("Change status")).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: "Done" }));
  await settle();
  expect(
    within(screen.getByRole("region", { name: "Done column" })).getByText(
      "Ticket 2",
    ),
  ).toBeTruthy();
});
