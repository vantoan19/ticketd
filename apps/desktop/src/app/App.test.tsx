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
      if (command === "dependency_graph")
        return {
          nodes: [],
          edges: [],
          max_nodes: 50,
          max_depth: 5,
          truncated: false,
        };
      throw new Error(`unexpected ${command}`);
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
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_efforts")
      return [{ id: "e1", name: "Old effort", archived: true }];
    if (command === "list_projects" || command === "find_tickets") return [];
    throw new Error(`unexpected ${command}`);
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole("button", { name: "Old effort" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Manage projects" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
    target: { value: "Draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Manage projects" }));
  expect(screen.getByRole("textbox", { name: "Project name" })).toHaveProperty(
    "value",
    "Draft",
  );
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
  expect(screen.getByRole("button", { name: /Filters • Active/ })).toBeTruthy();
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
      throw new Error(`unexpected ${command}`);
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
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_efforts")
      return [{ id: "e1", name: "Launch", archived: false }];
    if (command === "list_projects" || command === "find_tickets") return [];
    throw new Error(`unexpected ${command}`);
  });
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

test("preserves a creation draft when submission fails and the dialog is reopened", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string) => {
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
    throw new Error(`unexpected ${command}`);
  });
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

test("selects tickets independently and applies one bulk status change", async () => {
  vi.useFakeTimers();
  let tickets = ["First", "Second"].map((title, index) => ({
    id: String(index + 1),
    reference: `T-${index + 1}`,
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
  }));
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { references?: string[]; status?: string },
    ) => {
      if (command === "find_tickets") return tickets;
      if (command === "show_ticket") return tickets[0];
      if (command === "bulk_status") {
        tickets = tickets.map((ticket) =>
          args?.references?.includes(ticket.reference)
            ? { ...ticket, status: args.status! }
            : ticket,
        );
        return tickets;
      }
      return [];
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-2" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Change selected status" }),
  );
  fireEvent.change(screen.getByLabelText("Status for selected tickets"), {
    target: { value: "Done" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply status" }));
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: /First/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: /Second/ }).textContent).toContain(
    "Done",
  );
  expect(screen.queryByLabelText("Status for selected tickets")).toBeNull();
});

test("keeps keyboard selection and reports a failed bulk change for retry", async () => {
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
    if (command === "bulk_status")
      throw new Error("batch operation 0: ticket is trashed");
    return [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const checkbox = screen.getByRole("checkbox", { name: "Select T-1" });
  checkbox.focus();
  fireEvent.click(checkbox);
  fireEvent.click(
    screen.getByRole("button", { name: "Change selected status" }),
  );
  fireEvent.change(screen.getByLabelText("Status for selected tickets"), {
    target: { value: "Todo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply status" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("ticket is trashed");
  expect(screen.getByText("1 selected")).toBeTruthy();
  expect(screen.getByRole("button", { name: /First/ }).textContent).toContain(
    "Todo",
  );
});

test("applies a project to selected tickets without replacing other fields", async () => {
  vi.useFakeTimers();
  const ticket = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: ["existing"],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { references?: string[]; change?: { project_id?: string } },
    ) => {
      if (command === "find_tickets") return [ticket];
      if (command === "list_projects")
        return [{ id: "p1", name: "Project one", path: "/p", paths: ["/p"] }];
      if (command === "bulk_change") {
        expect(args?.references).toEqual(["T-1"]);
        expect(args?.change).toEqual({ project_id: "p1" });
        return [{ ...ticket, project_id: "p1" }];
      }
      return [];
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Change selected project" }),
  );
  fireEvent.change(screen.getByLabelText("Project for selected tickets"), {
    target: { value: "p1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply project" }));
  await act(async () => {});
  expect(screen.queryByLabelText("Status for selected tickets")).toBeNull();
});

test("clears Effort and removes a tag with explicit bulk actions", async () => {
  vi.useFakeTimers();
  const ticket = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: ["keep", "old"],
    project_id: null,
    effort_id: "e1",
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  const changes: unknown[] = [];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { change?: unknown }) => {
      if (command === "find_tickets") return [ticket];
      if (command === "bulk_change") {
        changes.push(args?.change);
        return [ticket];
      }
      return [];
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Change selected effort" }),
  );
  fireEvent.change(screen.getByLabelText("Effort for selected tickets"), {
    target: { value: "__clear__" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply Effort" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Change selected tags" }));
  fireEvent.change(screen.getByLabelText("Tag for selected tickets"), {
    target: { value: "old" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove tag" }));
  await act(async () => {});
  expect(changes).toEqual([{ effort_id: null }, { remove_tags: ["old"] }]);
});

test("shows attention for a reminder while another view is active and after reopening", async () => {
  vi.useFakeTimers();
  let unread = false;
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "has_unread_inbox") return unread;
    if (
      command === "list_projects" ||
      command === "list_efforts" ||
      command === "find_tickets"
    )
      return [];
    throw new Error(`unexpected ${command}`);
  });
  const app = render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Manage projects" }));
  unread = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("button", { name: "Inbox, unread" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
  app.unmount();
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("button", { name: "Inbox, unread" })).toBeTruthy();
});
