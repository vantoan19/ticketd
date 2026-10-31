// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;

let narrowViewport = false;
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: narrowViewport,
    addEventListener() {},
    removeEventListener() {},
  }),
});

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@/features/tickets/DependencyGraph", () => ({ default: () => null }));

vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
    readOnly,
    "aria-label": label,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly: boolean;
    "aria-label": string;
  }) => (
    <textarea
      aria-label={label}
      readOnly={readOnly}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  bridge.invoke.mockReset();
  localStorage.clear();
  narrowViewport = false;
  // A command no fake answers means the bridge contract moved under the test.
  const unknown = unknownCommands.splice(0);
  expect(unknown).toEqual([]);
});

test("refreshes clean content and preserves a draft when saved content changes", async () => {
  vi.useFakeTimers();
  let saved = {
    id: "1",
    trashed: false,
    reference: "T-1",
    title: "First",
    body: "Old",
    status: "Todo",
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(
    async (command: string, args?: { patch?: { title?: string } }) => {
      if (command === "list_projects" || command === "list_efforts") return [];
      if (command === "list_notes") return [];
      if (command === "find_tickets") return [saved];
      if (command === "show_ticket") return saved;
      if (command === "ticket_history") return [];
      if (command === "change_ticket" && args?.patch?.title) {
        saved = { ...saved, title: args.patch.title };
        return saved;
      }
      throw new Error("unexpected write");
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  saved = { ...saved, title: "External" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "External",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1900);
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "My draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Expand ticket" }));
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "My draft",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Return to ticket list" }),
  );
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "My draft",
  );
  saved = { ...saved, title: "Another change" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "My draft",
  );
  expect(screen.getByText(/Saved content changed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved content" }));
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Another change",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1900);
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Overwrite" },
  });
  saved = { ...saved, title: "External again" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save my draft" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(saved.title).toBe("Overwrite");
});

test("opens a related ticket outside the filtered list and preserves drafts when switching", async () => {
  vi.useFakeTimers();
  const ticket = (
    id: string,
    title: string,
  ): import("@/lib/api/client").Ticket => ({
    id,
    reference: `T-${id}`,
    title,
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  });
  let listVisible = true;
  const first = ticket("1", "First");
  const second = ticket("2", "Second");
  first.children = [
    { reference: second.reference, title: second.title, trashed: false },
  ];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (
        command === "list_projects" ||
        command === "list_efforts" ||
        command === "list_notes" ||
        command === "ticket_history"
      )
        return [];
      if (command === "find_tickets") return listVisible ? [first] : [];
      if (command === "show_ticket")
        return args?.reference === first.reference ? first : second;
      if (command === "contextual_relationships") {
        const empty = { items: [], next_offset: null };
        return {
          relationships: {
            parent: null,
            children:
              args?.reference === first.reference
                ? {
                    items: [
                      {
                        reference: second.reference,
                        title: { text: second.title },
                        status: "Todo",
                        trashed: false,
                        unresolved: true,
                      },
                    ],
                    next_offset: null,
                  }
                : empty,
            prerequisites: empty,
            blocking: empty,
            related: empty,
            discovered_while: empty,
            discoveries: empty,
            duplicate_of: null,
            duplicates: empty,
          },
        };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Unfinished title" },
  });
  listVisible = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Unfinished title",
  );
  expect(
    screen.getByText("This ticket is outside the current results."),
  ).toBeTruthy();
  listVisible = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New note source" }), {
    target: { value: "Unfinished note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Second",
  );
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.getByRole("textbox", { name: "New note source" }),
  ).toHaveProperty("value", "Unfinished note");
});

test("retains project drafts and clears filters when navigating scopes", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_efforts")
        return [{ id: "e1", name: "Old effort", archived: true }];
      if (command === "list_projects" || command === "find_tickets") return [];
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole("button", { name: "Old effort" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Manage projects" }));
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
    target: { value: "Draft" },
  });
  // Escape closes the dialog without discarding the draft.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(
    screen.queryByRole("navigation", { name: "Workspace views" }),
  ).toBeNull();
  expect(
    screen.getByRole("navigation", { name: "Settings sections" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to tickets" }));
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  expect(screen.getByRole("textbox", { name: "Project name" })).toHaveProperty(
    "value",
    "Draft",
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Workspace views" }),
    ).getByRole("button", { name: "All tickets" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  expect(screen.getByRole("dialog", { name: "Ticket filters" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: /Tags \(comma/ }), {
    target: { value: "bug" },
  });
  expect(
    screen.getByRole("button", { name: "Filters, 1 active" }),
  ).toBeTruthy();
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Workspace views" }),
    ).getByRole("button", { name: "All tickets" }),
  );
  expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
});

test("new ticket dialog focuses title and restores focus on Escape", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockResolvedValue([]);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  for (const name of ["New ticket", "Create your first ticket"]) {
    const trigger = screen.getByRole("button", { name });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Title" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  }
});

test("moves focus between ticket rows without opening them until Enter, and retains selection on refresh", async () => {
  vi.useFakeTimers();
  let tickets = [
    {
      id: "1",
      reference: "T-1",
      title:
        "A very long title that remains accessible even when the list truncates it",
      body: "",
      status: "Todo",
      trashed: false,
      tags: [],
      project_id: null,
      effort_id: null,
      availability: "Ready",
      prerequisites: [],
      parent: null,
      children: [],
    },
    {
      id: "2",
      reference: "T-2",
      title: "Second",
      body: "",
      status: "In progress",
      trashed: false,
      tags: [],
      project_id: null,
      effort_id: null,
      availability: null,
      prerequisites: [],
      parent: null,
      children: [],
    },
  ];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (
        [
          "list_projects",
          "list_efforts",
          "list_notes",
          "ticket_history",
        ].includes(command)
      )
        return [];
      if (command === "find_tickets") return tickets;
      if (command === "show_ticket")
        return tickets.find((ticket) => ticket.reference === args?.reference);
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const first = screen.getByRole("button", { name: /A very long title/ });
  const second = screen.getByRole("button", { name: /Second/ });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute("aria-pressed")).toBe("false");
  fireEvent.keyDown(second, { key: "Enter" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(second.getAttribute("aria-pressed")).toBe("true");
  tickets = [tickets[0]!, { ...tickets[1]!, status: "Done" }];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(
    screen.getByRole("button", { name: /Second/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: /Second/ }).textContent).toContain(
    "Done",
  );
});

test("clears additional filters while preserving the selected Effort", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_efforts")
        return [{ id: "e1", name: "Launch", archived: false }];
      if (command === "list_projects" || command === "find_tickets") return [];
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Tags \(comma/ }), {
    target: { value: "bug" },
  });
  expect(screen.getByRole("button", { name: "Remove Tag: bug" })).toBeTruthy();
  fireEvent.click(
    within(screen.getByLabelText("Active filters")).getByRole("button", {
      name: "Clear filters",
    }),
  );
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove Tag: bug" })).toBeNull();
});

test("removes one filter chip and shows the query when nothing matches", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_efforts" || command === "list_projects") return [];
      if (command === "find_tickets") return [];
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
    target: { value: "zebra" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Tags \(comma/ }), {
    target: { value: "bug, ui" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByText("No matching tickets")).toBeTruthy();
  expect(screen.getByText("zebra", { selector: "q" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove Tag: bug" }));
  expect(screen.queryByRole("button", { name: "Remove Tag: bug" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove Tag: ui" })).toBeTruthy();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!,
  );
  expect(screen.queryByText("zebra", { selector: "q" })).toBeNull();
  expect(screen.queryByLabelText("Active filters")).toBeNull();
});

test("preserves a creation draft when submission fails and the dialog is reopened", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_projects")
        return [
          {
            id: "p",
            name: "Desktop app",
            path: "/workspace",
            paths: ["/workspace"],
          },
        ];
      if (["list_efforts", "find_tickets", "search_tags"].includes(command))
        return [];
      if (command === "create_ticket") throw new Error("Creation failed");
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Desktop app" }));
  fireEvent.click(screen.getAllByRole("button", { name: /new ticket/i })[0]!);
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Draft ticket" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Description source" }),
    {
      target: { value: "Draft body" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("Creation failed");
  expect(bridge.invoke).toHaveBeenCalledWith(
    "create_ticket",
    expect.objectContaining({
      title: "Draft ticket",
      body: "Draft body",
      status: "Todo",
      projectId: "p",
      effortId: null,
      tags: [],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close new ticket" }));
  fireEvent.click(screen.getAllByRole("button", { name: /new ticket/i })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Description source" }),
  ).toHaveProperty("value", "Draft body");
});

test("keeps ticket rows mounted while a filter refresh is pending", async () => {
  vi.useFakeTimers();
  const ticket = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: ["bug"],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  let resolveRefresh: ((value: unknown) => void) | undefined;
  let calls = 0;
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") {
      if (calls++ === 0) return [ticket];
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    }
    if (command === "show_ticket") return ticket;
    return [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const row = screen.getByRole("button", { name: /First/ });
  fireEvent.click(row);
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Tags \(comma/ }), {
    target: { value: "bug" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("button", { name: /First/ })).toBe(row);
  await act(async () => {
    resolveRefresh?.([ticket]);
  });
  expect(screen.getByRole("button", { name: /First/ })).toBe(row);
  expect(row.getAttribute("aria-pressed")).toBe("true");
});

test("moves focus to the visible pane when expanding and returning", async () => {
  vi.useFakeTimers();
  const ticket = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    return [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const row = screen.getByRole("button", { name: /First/ });
  fireEvent.click(row);
  const expand = screen.getByRole("button", { name: "Expand ticket" });
  expand.focus();
  fireEvent.click(expand);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "T-1" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Return to ticket list" }),
  );
  expect(document.activeElement).toBe(row);
});

test("moves focus into the ticket on narrow screens and back to the row", async () => {
  vi.useFakeTimers();
  narrowViewport = true;
  const ticket = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    return [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const row = screen.getByRole("button", { name: /First/ });
  row.focus();
  fireEvent.keyDown(row, { key: "Enter" });
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "T-1" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Return to ticket list" }),
  );
  expect(document.activeElement).toBe(row);
});

const bulkTicket = (index: number, overrides = {}) => ({
  id: String(index),
  reference: `T-${index}`,
  title: ["First", "Second", "Third"][index - 1],
  body: "",
  status: "Todo",
  trashed: false,
  tags: [] as string[],
  project_id: null,
  effort_id: null,
  availability: "Ready",
  prerequisites: [],
  parent: null,
  children: [],
  ...overrides,
});

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
}

function openSubmenu(name: string) {
  fireEvent.keyDown(screen.getByRole("menuitem", { name }), {
    key: "ArrowRight",
  });
}

async function renderBulk(handlers: Record<string, unknown>) {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string, args?: unknown) => {
    const handler = handlers[command];
    if (typeof handler === "function") return handler(args);
    return handler ?? [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

test("shows the bulk bar only while tickets are selected and applies one status change", async () => {
  let tickets = [bulkTicket(1), bulkTicket(2)];
  await renderBulk({
    find_tickets: () => tickets,
    show_ticket: () => tickets[0],
    bulk_status: (args: { references: string[]; status: string }) => {
      tickets = tickets.map((ticket) =>
        args.references.includes(ticket.reference)
          ? { ...ticket, status: args.status }
          : ticket,
      );
      return tickets;
    },
  });
  expect(screen.queryByRole("region", { name: "Bulk edit" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select all 2" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Select all 2" })).toBeNull();
  openMenu("Change status of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: /First/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: /Second/ }).textContent).toContain(
    "Done",
  );
  expect(screen.queryByText("2 selected")).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Bulk edit" })).getByRole(
      "status",
    ).textContent,
  ).toContain("Set 2 tickets to Done");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
});

test("names the ticket that blocked a bulk change, keeps the selection, and retries with the same request ID", async () => {
  const requests: string[] = [];
  let fail = true;
  await renderBulk({
    find_tickets: () => [bulkTicket(1), bulkTicket(2)],
    bulk_status: (args: { requestId: string }) => {
      requests.push(args.requestId);
      if (fail)
        throw {
          code: "batch_operation",
          index: 1,
          message: "ticket is trashed",
        };
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-2" }));
  openMenu("Change status of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
  await act(async () => {});
  const alert = screen.getByRole("alert").textContent;
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Retry" }),
  );
  expect(alert).toContain("Nothing changed");
  expect(alert).toContain("T-2");
  expect(alert).toContain("ticket is trashed");
  expect(screen.getByText("2 selected")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {});
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("2 selected")).toBeNull();
  // The menu that started the change is gone; focus lands on the list heading.
  expect(document.activeElement).toBe(
    document.getElementById("tickets-heading"),
  );
});

test("moves selected tickets to a project from the Organize menu", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [bulkTicket(1)],
    list_projects: () => [
      { id: "p1", name: "Project one", path: "/p", paths: ["/p"] },
    ],
    bulk_change: (args: { references: string[]; change: unknown }) => {
      expect(args.references).toEqual(["T-1"]);
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  openMenu("Organize selected tickets");
  openSubmenu("Move to project");
  fireEvent.click(screen.getByRole("menuitem", { name: "Project one" }));
  await act(async () => {});
  expect(changes).toEqual([{ project_id: "p1" }]);
});

test("sets an Effort in one request and shows how many selected tickets already have each", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [
      bulkTicket(1, { effort_id: "e1" }),
      bulkTicket(2),
      bulkTicket(3),
    ],
    list_efforts: () => [
      { id: "e1", name: "Launch", archived: false },
      { id: "e2", name: "Polish", archived: false },
      { id: "e3", name: "Old", archived: true },
    ],
    bulk_change: (args: { change: unknown }) => {
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Select all 3" }));
  openMenu("Organize selected tickets");
  openSubmenu("Set Effort");
  expect(screen.getByRole("menuitem", { name: "Launch 1 of 3" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Polish 0 of 3" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Old/ })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Polish 0 of 3" }));
  await act(async () => {});
  expect(changes).toEqual([{ effort_id: "e2" }]);
});

test("removes an Effort and adds or removes a tag from the Organize menu", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [bulkTicket(1, { effort_id: "e1", tags: ["old"] })],
    bulk_change: (args: { change: unknown }) => {
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  openMenu("Organize selected tickets");
  openSubmenu("Set Effort");
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Effort" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  openMenu("Organize selected tickets");
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Add or remove tags…" }),
  );
  await act(async () => {});
  const dialog = screen.getByRole("dialog", {
    name: "Add or remove tag",
  });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Tag name" }), {
    target: { value: "old" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove tag" }));
  await act(async () => {});
  expect(changes).toEqual([{ effort_id: null }, { remove_tags: ["old"] }]);
});

test("shows attention for a reminder while another view is active and after reopening", async () => {
  vi.useFakeTimers();
  let unread = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "sidebar_counts")
        return { unread_inbox: unread, ready: 4, in_progress: 2 };
      if (
        command === "list_projects" ||
        command === "list_efforts" ||
        command === "find_tickets"
      )
        return [];
      return bridgeDefault(command, args);
    },
  );
  const app = render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Manage projects" }));
  unread = 3;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("button", { name: "Inbox, 3 unread" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Ready 4" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "In progress 2" })).toBeTruthy();
  app.unmount();
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("button", { name: "Inbox, 3 unread" })).toBeTruthy();
  unread = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("button", { name: "Inbox" })).toBeTruthy();
});

test("opens a ticket from the list at full width when Open tickets says so", async () => {
  vi.useFakeTimers();
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ theme: "system", openTickets: "expanded" }),
  );
  const ticket = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    return [];
  });
  const { container } = render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  expect(container.querySelector(".ticket-workspace.expanded")).not.toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Return to ticket list" }),
  );
  expect(container.querySelector(".ticket-workspace.expanded")).toBeNull();
});

test("the narrow navigation trigger shows its label and gets focus back when the sheet closes", async () => {
  vi.useFakeTimers();
  narrowViewport = true;
  bridge.invoke.mockImplementation(async () => []);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  expect(trigger.textContent).toContain("Navigation");
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
  // Focus lands on a control with a tooltip; the first Escape closes the tooltip.
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.keyDown(document, { key: "Escape" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("Settings reads fresh data on every visit, checks the CLI only once opened, and moves focus in and out", async () => {
  vi.useFakeTimers();
  let tickets = 1;
  const calls: string[] = [];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      calls.push(command);
      if (command === "list_projects" || command === "list_efforts") return [];
      if (command === "find_tickets") return [];
      if (command === "workspace_info")
        return {
          path: "/data/ticketd.sqlite3",
          tickets,
          projects: 0,
          active_efforts: 0,
          size_bytes: 4096,
          format_version: 20,
        };
      if (command === "last_backup") return null;
      if (command === "check_cli") throw new Error("not installed");
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(calls).not.toContain("check_cli");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(calls).toContain("check_cli");
  expect(
    screen.getByRole("region", { name: "Location" }).textContent,
  ).toContain("Tickets1");
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Settings" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Back to tickets/ }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Settings" }),
  );
  tickets = 7;
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.getByRole("region", { name: "Location" }).textContent,
  ).toContain("Tickets7");
});

test("a selection ends when the search or filters change, and the bar can be skipped to", async () => {
  await renderBulk({ find_tickets: () => [bulkTicket(1), bulkTicket(2)] });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
  const skip = screen.getByRole("link", { name: "Skip to selection actions" });
  fireEvent.click(skip);
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Bulk edit" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
    target: { value: "second" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.queryByText("1 selected")).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Skip to selection actions" }),
  ).toBeNull();
});
