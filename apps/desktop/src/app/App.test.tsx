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
  constructor(private callback: ResizeObserverCallback) {}
  // The Tickets workspace stacks its panes when the content panel is narrow.
  observe(target: Element) {
    if (narrowViewport && target.classList.contains("plan-workspace"))
      this.callback(
        [{ contentRect: { width: 500 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
  }
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

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  // Moves on every poll, so each tick looks like a change made elsewhere.
  token: { next: (): number => 0 },
}));
let tokenCalls = 0;
bridge.token.next = () => ++tokenCalls;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    if (command === "find_tickets_with_updates") {
      const tickets: unknown[] = await bridge.invoke("find_tickets", args);
      return tickets.map((ticket) => ({ ticket, latest_update: null }));
    }
    if (command === "workspace_change_token") return bridge.token.next();
    return bridge.invoke(command, args);
  },
}));
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

test("Attachments opens from the existing Context navigation without replacing ticket views", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
  expect(
    await screen.findByRole("heading", { name: "Attachments" }),
  ).toBeTruthy();
  // An empty library says so, with no search over nothing (P9).
  expect(await screen.findByText("No attachments yet")).toBeTruthy();
  expect(screen.queryByRole("searchbox", { name: "Search files" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^All tickets/ }));
  expect(screen.queryByRole("heading", { name: "Attachments" })).toBeNull();
});

test("Storage settings in the Attachments library opens Settings at Attachments", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Storage settings" }),
  );
  const nav = await screen.findByRole("navigation", {
    name: "Settings sections",
  });
  expect(nav.querySelector("[aria-current=page]")?.textContent).toContain(
    "Attachments",
  );
});

async function openManageMenu(label: string, item: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: label }), {
    key: "Enter",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** One ticket for an unfiltered read, none once a search or filter narrows it. */
function unfilteredOnly(args: unknown) {
  const filter = (
    args as {
      filter?: { query?: string; tags?: string[]; status?: string | null };
    }
  )?.filter;
  const narrowed =
    Boolean(filter?.query) ||
    (filter?.tags?.length ?? 0) > 0 ||
    Boolean(filter?.status);
  return narrowed ? [] : [bulkTicket(1)];
}

/** The sidebar's New ticket button; an empty list may offer its own New ticket too. */
const sidebarNewTicket = () =>
  screen.getAllByRole("button", { name: "New ticket" })[0]!;

/** One click opens New ticket (shell SH-11: it was a two-click menu). */
async function openNewTicket(trigger = sidebarNewTicket()) {
  fireEvent.click(trigger);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

test("refreshes clean content and preserves a draft when saved content changes", async () => {
  vi.useFakeTimers();
  let saved = {
    id: "1",
    trashed: false,
    reference: "T-KQ1",
    title: "First",
    body: "Old",
    status: "Todo",
    tags: [],
    project_id: null,
    plan_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(
    async (command: string, args?: { patch?: { title?: string } }) => {
      if (command === "list_projects" || command === "list_plans") return [];
      if (command === "activity_feed") return [];
      if (command === "find_tickets") return [saved];
      if (command === "count_tickets") return bridgeDefault(command);
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
  expect(screen.getByText(/saved title changed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use saved text" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
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
    reference: `T-KQ${id}`,
    title,
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
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
        command === "list_plans" ||
        command === "activity_feed" ||
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
            children_progress: {
              total: args?.reference === first.reference ? 1 : 0,
              done: 0,
            },
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
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New update source" }), {
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
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", "Unfinished note");
});

test("retains project drafts and clears filters when navigating scopes", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_plans")
        return [{ id: "e1", name: "Old plan", archived: true }];
      // One unfiltered ticket: an empty workspace offers no Filters (P9).
      if (command === "find_tickets") return unfilteredOnly(args);
      if (command === "list_projects") return [];
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole("button", { name: "Old plan" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
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
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
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
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Ticket filters" })).getByRole(
      "button",
      { name: "Todo" },
    ),
  );
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

test("an idle workspace costs one token poll per tick and refetches only when the token moves", async () => {
  vi.useFakeTimers();
  let token = 1;
  bridge.token.next = () => token;
  const calls: string[] = [];
  bridge.invoke.mockImplementation(async (command: string) => {
    calls.push(command);
    return command === "count_tickets" ? bridgeDefault(command) : [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const loaded = calls.length;
  const listed = () => calls.filter((c) => c === "find_tickets").length;
  expect(listed()).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  // Ten idle seconds: no view fetched anything, only the token was polled.
  expect(calls.length).toBe(loaded);
  token = 2;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(listed()).toBe(2);
  bridge.token.next = () => ++tokenCalls;
});

test("lists No project after the named projects and shows a quiet hint with nothing selected", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) =>
      command === "list_projects"
        ? [{ id: "p1", name: "Billing API", path: "/b", paths: ["/b"] }]
        : bridgeDefault(command, args),
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const scopes = within(
    screen.getByRole("navigation", { name: "Project scopes" }),
  ).getAllByRole("button");
  expect(scopes.map((item) => item.textContent?.trim())).toEqual([
    "Billing API",
    "No project",
  ]);
  expect(screen.queryByText("Unlinked")).toBeNull();
  expect(screen.getByText("Select a ticket to read it here")).toBeTruthy();
});

test("changing the scope drops an open ticket that is outside it", async () => {
  vi.useFakeTimers();
  const ticket = {
    id: "1",
    reference: "T-KQ1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  let scoped = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_projects")
        return [{ id: "p1", name: "Billing API", path: "/b", paths: ["/b"] }];
      if (command === "find_tickets") return scoped ? [] : [ticket];
      if (command === "show_ticket") return ticket;
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
  expect(screen.getByRole("textbox", { name: "Title" })).toBeTruthy();
  scoped = true;
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Project scopes" }),
    ).getByRole("button", { name: "Billing API" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  expect(
    screen.queryByText("This ticket is outside the current results."),
  ).toBeNull();
});

test("new ticket dialog focuses title and restores focus on Escape", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "count_tickets" ? bridgeDefault(command) : [],
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // The sidebar's menu, then the first-run empty state's own New ticket.
  for (const index of [0, 1]) {
    const trigger = screen.getAllByRole("button", { name: "New ticket" })[
      index
    ]!;
    trigger.focus();
    if (index === 0) await openNewTicket(trigger);
    else fireEvent.click(trigger);
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

test("choosing New ticket closes the New ticket tooltip", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "count_tickets" ? bridgeDefault(command) : [],
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const trigger = sidebarNewTicket();
  fireEvent.keyDown(document.body, { key: "Tab" });
  trigger.focus();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryAllByRole("tooltip").length).toBeGreaterThan(0);
  await openNewTicket(trigger);
  expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
  expect(screen.queryAllByRole("tooltip")).toHaveLength(0);
});

test("C opens New ticket from anywhere, but not while typing", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
  const search = document.createElement("input");
  document.body.append(search);
  fireEvent.keyDown(search, { key: "c" });
  expect(screen.queryByRole("dialog", { name: "New ticket" })).toBeNull();
  search.remove();
  fireEvent.keyDown(document.body, { key: "c" });
  expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Attachments", hidden: true }),
  ).toBeTruthy();
});

test("the Projects and Plans headings open their pages and mark them current", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const projects = screen.getByRole("button", { name: "Projects" });
  const plans = screen.getByRole("button", { name: "Plans" });
  fireEvent.click(projects);
  expect(projects.getAttribute("aria-current")).toBe("page");
  expect(plans.getAttribute("aria-current")).toBeNull();
  fireEvent.click(plans);
  expect(plans.getAttribute("aria-current")).toBe("page");
  expect(projects.getAttribute("aria-current")).toBeNull();
});

test("New ticket opens over the current view instead of switching to Tickets", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await openNewTicket();
  expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
  // Behind the dialog, which hides the rest of the window from the tree.
  expect(
    screen.getByRole("heading", { name: "Attachments", hidden: true }),
  ).toBeTruthy();
});

test("a sidebar choice that could not be saved stays reported after the list loads again", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("quota");
    });
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  setItem.mockRestore();
  const notice = /Couldn't save the sidebar state/;
  expect(screen.getByRole("alert").textContent).toMatch(notice);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText(notice)).toBeTruthy();
  // A save that works clears it.
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.queryByText(notice)).toBeNull();
});

test("moves focus between ticket rows without opening them until Enter, and retains selection on refresh", async () => {
  vi.useFakeTimers();
  let tickets = [
    {
      id: "1",
      reference: "T-KQ1",
      title:
        "A very long title that remains accessible even when the list truncates it",
      body: "",
      status: "Todo",
      trashed: false,
      tags: [],
      project_id: null,
      plan_id: null,
      availability: "Ready",
      prerequisites: [],
      parent: null,
      children: [],
    },
    {
      id: "2",
      reference: "T-KQ2",
      title: "Second",
      body: "",
      status: "In progress",
      trashed: false,
      tags: [],
      project_id: null,
      plan_id: null,
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
          "list_plans",
          "activity_feed",
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
  // The In progress group lists before the Todo group.
  const first = screen.getByRole("button", { name: /Second/ });
  const second = screen.getByRole("button", { name: /A very long title/ });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute("aria-pressed")).toBe("false");
  fireEvent.keyDown(second, { key: "Enter" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(second.getAttribute("aria-pressed")).toBe("true");
  tickets = [{ ...tickets[0]!, status: "Done" }, tickets[1]!];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(
    screen
      .getByRole("button", { name: /A very long title/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  // The row moved to the Done group; the group header names its status.
  expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Todo" })).toBeNull();
});

test("clears additional filters while preserving the selected Plan", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_plans")
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
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Ticket filters" })).getByRole(
      "button",
      { name: "Todo" },
    ),
  );
  expect(
    screen.getByRole("button", { name: "Remove Status is Todo" }),
  ).toBeTruthy();
  fireEvent.click(
    within(screen.getByLabelText("Active filters")).getByRole("button", {
      name: "Clear filters",
    }),
  );
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Remove Status is Todo" }),
  ).toBeNull();
});

test("removes one filter chip and shows the query when nothing matches", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_plans" || command === "list_projects") return [];
      // One unfiltered ticket: an empty workspace offers no Search (P9).
      if (command === "find_tickets") return unfilteredOnly(args);
      if (command === "search_tags") return ["bug", "ui"];
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Search tickets" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
    target: { value: "zebra" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const filters = within(
    screen.getByRole("dialog", { name: "Ticket filters" }),
  );
  fireEvent.click(filters.getByRole("button", { name: "bug" }));
  fireEvent.click(filters.getByRole("button", { name: "ui" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByText("No tickets match “zebra”")).toBeTruthy();
  expect(
    screen.getByText(
      /Searched titles, descriptions and updates in All tickets, with 2 filters on/,
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove Tag is bug" }));
  expect(
    screen.queryByRole("button", { name: "Remove Tag is bug" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Remove Tag is ui" })).toBeTruthy();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!,
  );
  expect(screen.queryByText(/Searched titles/)).toBeNull();
  expect(screen.queryByLabelText("Active filters")).toBeNull();
});

test("a filter applies live, counts N of M, and Done closes the panel", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { filter?: { status: string | null } }) => {
      if (command === "count_tickets")
        return {
          ...(bridgeDefault(command) as object),
          total: args?.filter?.status ? 3 : 7,
        };
      return bridgeDefault(command);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  const panel = within(screen.getByRole("dialog", { name: "Ticket filters" }));
  fireEvent.click(panel.getByRole("button", { name: "Todo" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  // The count sits beside the title, not in the constraint row.
  expect(screen.getByLabelText("Active filters").textContent).not.toContain(
    "of 7",
  );
  expect(
    screen.getByRole("heading", { name: "All tickets" }).parentElement!
      .textContent,
  ).toContain("3 of 7");
  expect(panel.getByText("3 of 7 tickets match")).toBeTruthy();
  // Clear all sits in the header (board C); the footer has the count and Done.
  expect(
    within(
      panel.getByRole("heading", { name: "Filters" }).parentElement!,
    ).getByRole("button", { name: "Clear all" }),
  ).toBeTruthy();
  // The Done status chip shares the name; the footer button comes last.
  fireEvent.click(panel.getAllByRole("button", { name: "Done" }).at(-1)!);
  expect(screen.queryByRole("dialog", { name: "Ticket filters" })).toBeNull();
});

test("preserves a creation draft when submission fails and the dialog is reopened", async () => {
  await import("@/features/markdown/MarkdownEditor");
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
      if (["list_plans", "find_tickets", "search_tags"].includes(command))
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
  await openNewTicket();
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
      planId: null,
      tags: [],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await openNewTicket();
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Description source" }),
  ).toHaveProperty("value", "Draft body");
});

test("keeps ticket rows mounted while a filter refresh is pending", async () => {
  vi.useFakeTimers();
  const ticket = {
    id: "1",
    reference: "T-KQ1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: ["bug"],
    project_id: null,
    plan_id: null,
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
    return command === "count_tickets" ? bridgeDefault(command) : [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const row = screen.getByRole("button", { name: /First/ });
  fireEvent.click(row);
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Ticket filters" })).getByRole(
      "button",
      { name: "Todo" },
    ),
  );
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
    reference: "T-KQ1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    return command === "count_tickets" ? bridgeDefault(command) : [];
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
    screen.getByRole("heading", { name: "T-KQ1" }),
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
    reference: "T-KQ1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    return command === "count_tickets" ? bridgeDefault(command) : [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const row = screen.getByRole("button", { name: /First/ });
  row.focus();
  fireEvent.keyDown(row, { key: "Enter" });
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "T-KQ1" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Return to ticket list" }),
  );
  expect(document.activeElement).toBe(row);
});

const bulkTicket = (index: number, overrides = {}) => ({
  id: String(index),
  reference: `T-KQ${index}`,
  title: ["First", "Second", "Third"][index - 1],
  body: "",
  status: "Todo",
  trashed: false,
  tags: [] as string[],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  prerequisites: [],
  parent: null,
  children: [],
  ...overrides,
});

test.each(["split", "expanded", "beside", "narrow"])(
  "closing %s ticket details restores focus to the just-viewed row",
  async (mode) => {
    narrowViewport = mode === "narrow";
    const tickets = [bulkTicket(1), bulkTicket(2)];
    await renderBulk({
      find_tickets: () => tickets,
      show_ticket: ({ reference }: { reference: string }) =>
        tickets.find((ticket) => ticket.reference === reference),
    });
    const first = screen.getByRole("button", { name: /First/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("button", { name: /Second/ });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "Enter" });
    await act(async () => {});
    if (mode === "expanded" || mode === "beside") {
      fireEvent.click(screen.getByRole("button", { name: "Expand ticket" }));
      if (mode === "beside")
        fireEvent.click(
          screen.getByRole("button", { name: "Show beside the list" }),
        );
    }
    const close = screen.getByRole("button", { name: "Close ticket details" });
    close.focus();
    fireEvent.click(close);
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-pressed")).toBe("false");
  },
);

test("closing after Next restores focus to the current ticket rather than the original row", async () => {
  const tickets = [bulkTicket(1), bulkTicket(2)];
  await renderBulk({
    find_tickets: () => tickets,
    count_tickets: counted({ todo: 2 }),
    show_ticket: ({ reference }: { reference: string }) =>
      tickets.find((ticket) => ticket.reference === reference),
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Next ticket" }));
  await act(async () => {});
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Second",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close ticket details" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /Second/ }),
  );
});

test("closing details falls back to the list heading when the ticket has left the visible results", async () => {
  let tickets = [bulkTicket(1), bulkTicket(2)];
  const viewed = tickets[1];
  await renderBulk({
    find_tickets: () => tickets,
    show_ticket: () => viewed,
  });
  fireEvent.click(screen.getByRole("button", { name: /Second/ }));
  await act(async () => {});
  tickets = [bulkTicket(1)];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByRole("button", { name: /Second/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close ticket details" }));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "All tickets" }),
  );
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
    if (command === "count_tickets") return handler ?? bridgeDefault(command);
    return handler ?? [];
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

test("a failed refresh keeps saved tickets and shows its actionable cause until recovery", async () => {
  let missing = false;
  const cause =
    "cannot reopen workspace at /data/ticketd/workspace.sqlite3: unable to open database file. Restore the workspace file or make its folder available, then retry";
  await renderBulk({
    find_tickets: () => {
      if (missing) throw new Error(cause);
      return [bulkTicket(1)];
    },
  });
  const row = screen.getByRole("button", { name: /First/ });
  missing = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText(/Can’t refresh/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /First/ })).toBe(row);

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // The line keeps its place; the cause waits under Details.
  expect(screen.getByText(/Can’t refresh/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(cause)).toBeTruthy();
  expect(screen.getByRole("button", { name: /First/ })).toBe(row);

  missing = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Can’t refresh/)).toBeNull();
  expect(screen.getByRole("button", { name: /First/ })).toBe(row);
});

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
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select all 2" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Select all 2" })).toBeNull();
  openMenu("Status of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: /First/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
  expect(screen.queryByText("2 selected")).toBeNull();
  // The outcome is the pane's status line, where the bar was (P6).
  expect(
    screen
      .getAllByRole("status")
      .some((line) => line.textContent?.includes("Set 2 tickets to Done")),
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
});

test("keeps the selection and retries a failed bulk change with the same request ID", async () => {
  const requests: string[] = [];
  let fail = true;
  await renderBulk({
    find_tickets: () => [bulkTicket(1), bulkTicket(2)],
    bulk_status: (args: { requestId: string }) => {
      requests.push(args.requestId);
      if (fail) throw { code: "failed", message: "storage is busy" };
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ2" }));
  openMenu("Status of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
  await act(async () => {});
  const alert = screen.getByRole("alert").textContent;
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Retry" }),
  );
  expect(alert).toContain("Nothing changed");
  expect(alert).toContain("Storage is busy");
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

test("names the ticket the core rejected and offers no Retry that cannot succeed", async () => {
  await renderBulk({
    find_tickets: () => [bulkTicket(1), bulkTicket(2)],
    bulk_status: () => {
      throw {
        code: "batch_operation",
        index: 1,
        message: "invalid batch: T-KQ2 is trashed",
      };
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ2" }));
  openMenu("Status of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
  await act(async () => {});
  const alert = screen.getByRole("alert");
  expect(alert.getAttribute("data-slot")).toBe("status-line");
  expect(alert.textContent).toContain("T-KQ2 is trashed");
  expect(alert.textContent).toContain("Nothing changed.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(alert.contains(document.activeElement)).toBe(true);
  expect(screen.getByText("2 selected")).toBeTruthy();
});

test("moves selected tickets to a project from the Organize menu", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [bulkTicket(1)],
    list_projects: () => [
      { id: "p1", name: "Project one", path: "/p", paths: ["/p"] },
    ],
    bulk_change: (args: { references: string[]; change: unknown }) => {
      expect(args.references).toEqual(["T-KQ1"]);
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  openMenu("Organize selected tickets");
  openSubmenu("Move to project");
  fireEvent.click(screen.getByRole("menuitem", { name: "Project one" }));
  await act(async () => {});
  expect(changes).toEqual([{ project_id: "p1" }]);
});

test("sets an Plan in one request and shows how many selected tickets already have each", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [
      bulkTicket(1, { plan_id: "e1" }),
      bulkTicket(2),
      bulkTicket(3),
    ],
    list_plans: () => [
      { id: "e1", name: "Launch", archived: false },
      { id: "e2", name: "Polish", archived: false },
      { id: "e3", name: "Old", archived: true },
    ],
    bulk_change: (args: { change: unknown }) => {
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("button", { name: "Select all 3" }));
  openMenu("Organize selected tickets");
  openSubmenu("Set Plan");
  expect(screen.getByRole("menuitem", { name: "Launch 1 of 3" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Polish 0 of 3" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Old/ })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Polish 0 of 3" }));
  await act(async () => {});
  expect(changes).toEqual([{ plan_id: "e2" }]);
});

test("removes an Plan and adds or removes a tag from the Organize menu", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [bulkTicket(1, { plan_id: "e1", tags: ["old"] })],
    bulk_change: (args: { change: unknown }) => {
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  openMenu("Organize selected tickets");
  openSubmenu("Set Plan");
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Plan" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  openMenu("Organize selected tickets");
  expect(screen.queryByRole("menuitem", { name: /Add or remove/ })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove tag…" }));
  await act(async () => {});
  const dialog = screen.getByRole("dialog", { name: "Remove tag" });
  expect(within(dialog).queryByRole("button", { name: "Add tag" })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Search tags"), {
    target: { value: "old" },
  });
  fireEvent.click(within(dialog).getByRole("option", { name: "old" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove tag" }));
  await act(async () => {});
  expect(changes).toEqual([{ plan_id: null }, { remove_tags: ["old"] }]);
});

test("Organize has a separate Add tag action", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [bulkTicket(1)],
    bulk_change: (args: { change: unknown }) => {
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  openMenu("Organize selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Add tag…" }));
  await act(async () => {});
  const dialog = screen.getByRole("dialog", { name: "Add tag" });
  expect(
    within(dialog).queryByRole("button", { name: "Remove tag" }),
  ).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Search tags"), {
    target: { value: "new" },
  });
  fireEvent.click(within(dialog).getByRole("option", { name: "Create “new”" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Add tag" }));
  await act(async () => {});
  expect(changes).toEqual([{ add_tags: ["new"] }]);
});

test("the status menu counts tickets per status and checks the one all share", async () => {
  await renderBulk({
    find_tickets: () => [
      bulkTicket(1),
      bulkTicket(2),
      bulkTicket(3, { status: "Done" }),
    ],
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ2" }));
  openMenu("Status of selected tickets");
  expect(screen.getByText("Set status for 2 tickets")).toBeTruthy();
  const todo = screen.getByRole("menuitem", { name: /^Todo/ });
  expect(todo.textContent).toContain("both");
  expect(todo.querySelector("svg.bulk-status-check")).not.toBeNull();
  expect(screen.getByRole("menuitem", { name: "Done" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ3" }));
  openMenu("Status of selected tickets");
  const mixed = screen.getByRole("menuitem", { name: /^Todo/ });
  expect(mixed.textContent).toContain("2 of 3");
  expect(mixed.querySelector("svg.bulk-status-check")).toBeNull();
});

test("Escape clears the selection and the bar shows the shortcut", async () => {
  await renderBulk({ find_tickets: () => [bulkTicket(1)] });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  expect(
    screen.getByRole("button", { name: "Clear selection" }).textContent,
  ).toContain("Esc");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByText("1 selected")).toBeNull();
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
        command === "list_plans" ||
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
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
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
    reference: "T-KQ1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    return command === "count_tickets" ? bridgeDefault(command) : [];
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
  // Focus lands on a row whose rail tooltip is not mounted in the sheet, so
  // the first Escape closes the sheet (shell SH-17).
  fireEvent.keyDown(document, { key: "Escape" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("Settings reads fresh data on every visit, checks the CLI at startup and again once opened, and moves focus in and out", async () => {
  vi.useFakeTimers();
  let tickets = 1;
  const calls: string[] = [];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      calls.push(command);
      if (command === "list_projects" || command === "list_plans") return [];
      if (command === "find_tickets") return [];
      if (command === "workspace_info")
        return {
          path: "/data/ticketd.sqlite3",
          tickets,
          documents: 0,
          projects: 0,
          active_plans: 0,
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
  // Read at startup for the Settings nav dot, so it is there on first paint.
  const cliChecks = () => calls.filter((call) => call === "check_cli").length;
  expect(cliChecks()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(cliChecks()).toBeGreaterThan(1);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { level: 1, name: "Appearance" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Location" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.getByRole("region", { name: "Contents" }).textContent,
  ).toContain("Tickets1");
  fireEvent.click(screen.getByRole("button", { name: /Back to tickets/ }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Settings" }),
  );
  // LIVE2-12: the row under the resting pointer shows no hover fill until it moves.
  expect(document.documentElement.dataset.hoverHeld).toBe("");
  fireEvent.pointerMove(document.body);
  expect(document.documentElement.dataset.hoverHeld).toBeUndefined();
  tickets = 7;
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Location" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.getByRole("region", { name: "Contents" }).textContent,
  ).toContain("Tickets7");
});

test("a selection ends when the search or filters change, and the bar can be skipped to", async () => {
  await renderBulk({ find_tickets: () => [bulkTicket(1), bulkTicket(2)] });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
  const skip = screen.getByRole("link", { name: "Skip to selection actions" });
  fireEvent.click(skip);
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Bulk edit" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Search tickets" }));
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

const zeroCounts = {
  total: 0,
  todo: 0,
  in_progress: 0,
  in_review: 0,
  done: 0,
  canceled: 0,
  duplicate: 0,
};
/** Counts as the core reports them, with `total` summed over the statuses. */
const counted = (counts: Partial<typeof zeroCounts>) => {
  const merged = { ...zeroCounts, ...counts, total: 0 };
  merged.total =
    merged.todo +
    merged.in_progress +
    merged.in_review +
    merged.done +
    merged.canceled +
    merged.duplicate;
  return merged;
};

test("the list header stays outside the scroller that holds the rows", async () => {
  await renderBulk({
    find_tickets: () => [bulkTicket(1), bulkTicket(2)],
    count_tickets: counted({ todo: 120 }),
  });
  const scroller = document.querySelector(".ticket-scroll");
  expect(scroller).toBeTruthy();
  // Title, toolbar and source tabs stay fixed; rows and paging scroll under them.
  expect(
    scroller?.contains(screen.getByRole("heading", { name: "All tickets" })),
  ).toBe(false);
  expect(scroller?.contains(document.querySelector(".ticket-rows"))).toBe(true);
  expect(scroller?.contains(screen.getByRole("button", { name: "Next" }))).toBe(
    true,
  );
});

test("totals and group counts describe the whole result, not the loaded page", async () => {
  await renderBulk({
    find_tickets: () => [
      bulkTicket(1, { status: "In progress", availability: null }),
      bulkTicket(2),
    ],
    count_tickets: counted({ in_progress: 1, todo: 119 }),
  });
  expect(screen.getByRole("heading", { name: "All tickets" })).toBeTruthy();
  expect(
    screen.getByText("120", {
      selector: '.ui-pane-header [data-slot="count"]',
    }),
  ).toBeTruthy();
  // One Todo ticket is on this page of the 119 in the result.
  expect(screen.getByText("1 of 119")).toBeTruthy();
  expect(screen.getByText(/Showing 1–2 of 120/)).toBeTruthy();
  const next = screen.getByRole("button", { name: "Next" });
  expect((next as HTMLButtonElement).disabled).toBe(false);
  // The list is requested in workflow order and counted with the same filter.
  const asked = bridge.invoke.mock.calls
    .filter(([command]) => command === "find_tickets")
    .map(([, args]) => args.filter.order);
  expect(new Set(asked)).toEqual(new Set(["Workflow"]));
  const countCall = bridge.invoke.mock.calls.find(
    // The Projects page counts tickets without a project; skip that one.
    ([command, args]) =>
      command === "count_tickets" && args.filter.unlinked === false,
  );
  expect(countCall?.[1].filter.order).toBe("Workflow");
});

test("single-status views say in one line what they list", async () => {
  await renderBulk({});
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  expect(screen.queryByText(/nothing left to wait on/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
  await settle();
  expect(screen.getByText(/nothing left to wait on/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^In progress/ }));
  await settle();
  expect(screen.getByText(/working on right now/)).toBeTruthy();
  expect(screen.queryByText(/nothing left to wait on/)).toBeNull();
});

test("the source filter narrows list and counts together and Refresh imports on demand", async () => {
  const github = bulkTicket(1, {
    source: {
      provider: "github",
      provider_name: "GitHub",
      place: "acme/api",
      number: "#98",
      status_choices: ["Todo", "In progress", "In review"],
      id: "9",
      locator: "acme/api#98",
      display: "acme/api#98",
      url: "https://github.com/acme/api/issues/98",
      origin: "imported",
      ownership: "external",
      state: { state: "open" },
      closure_unrecognized: false,
      last_refreshed_at: null,
      last_attempt_at: null,
      last_error: null,
      content_locked: true,
      status_locked: false,
      duplicate_target: null,
    },
  });
  await renderBulk({
    find_tickets: () => [github],
    count_tickets: counted({ todo: 1 }),
    count_by_source: { all: 3, local: 2, providers: { github: 1 } },
    list_sources: [
      {
        connector: {
          provider: "github",
          name: "GitHub",
          contract_version: 1,
          capabilities: ["discover", "fetch"],
          schema: { fields: [] },
        },
        saved: {
          provider: "github",
          config: {},
          account: "octo",
          saved_at: "2026-02-01T00:00:00Z",
        },
      },
    ],
    refresh_sources: {
      imported: ["T-KQ1"],
      updated: [],
      unchanged: 0,
      failures: [],
      refreshed_at: "2026-02-01T00:00:00Z",
    },
  });
  const filter = screen.getByRole("radiogroup", { name: "Ticket source" });
  expect(
    within(filter)
      .getAllByRole("radio")
      .map((radio) => radio.textContent),
  ).toEqual(["All 3", "GitHub 1", "Local 2"]);
  expect(screen.getByText("#98")).toBeTruthy();
  fireEvent.click(within(filter).getByRole("radio", { name: /GitHub/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const sourceOf = (command: string) =>
    bridge.invoke.mock.calls
      .filter(([name]) => name === command)
      .map(([, args]) => args.filter.source)
      .at(-1);
  expect(sourceOf("find_tickets")).toEqual({ Provider: "github" });
  expect(sourceOf("count_tickets")).toEqual({ Provider: "github" });
  // The list's one Refresh also imports from the configured sources.
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {});
  expect(bridge.invoke).toHaveBeenCalledWith("refresh_sources", {
    ticket: null,
  });
  expect(screen.queryByText("1 new, 0 updated")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toHaveProperty(
    "disabled",
    false,
  );
});

test("the sidebar footer follows persisted source health and keeps the list", async () => {
  let health: unknown = {
    refreshing: false,
    sources: [
      {
        provider: "github",
        last_attempt_at: "2026-02-01T00:10:00Z",
        last_refreshed_at: "2026-02-01T00:00:00Z",
        error: { code: "unavailable", message: "Network is down." },
        failing_since: "2026-02-01T00:10:00Z",
        retry_after: null,
        unavailable_tickets: 1,
        health: "unavailable",
        partial_message: null,
      },
    ],
  };
  await renderBulk({
    find_tickets: () => [bulkTicket(1)],
    count_tickets: counted({ todo: 1 }),
    source_health: () => health,
  });
  const footer = screen.getByRole("group", { name: "Ticket sources" });
  expect(within(footer).getByText("1 source issue")).toBeTruthy();
  // The failure never empties the list.
  expect(screen.getByText("First")).toBeTruthy();
  // A refresh started elsewhere (startup or periodic) shows up on the next poll.
  health = { ...(health as object), refreshing: true };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(within(footer).getByText("Refreshing GitHub…")).toBeTruthy();
  health = {
    refreshing: false,
    sources: [
      {
        provider: "github",
        last_attempt_at: "2026-02-01T00:20:00Z",
        last_refreshed_at: "2026-02-01T00:20:00Z",
        error: null,
        failing_since: null,
        retry_after: null,
        unavailable_tickets: 0,
        health: "synced",
        partial_message: null,
      },
    ],
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(within(footer).queryByText("GitHub unavailable")).toBeNull();
  expect(within(footer).getByText(/GitHub synced/)).toBeTruthy();
});

test("Previous and Next follow the visible list across groups and keep the selection", async () => {
  const tickets = [
    bulkTicket(2, { status: "In progress", availability: null }),
    bulkTicket(1),
    bulkTicket(3),
  ];
  await renderBulk({
    find_tickets: () => tickets,
    show_ticket: (args: { reference: string }) =>
      tickets.find((item) => item.reference === args.reference),
    count_tickets: counted({ in_progress: 1, todo: 2 }),
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await act(async () => {});
  expect(screen.getByText("2 of 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next ticket" }));
  await act(async () => {});
  expect(screen.getByText("3 of 3")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Next ticket" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous ticket" }));
  await act(async () => {});
  expect(screen.getByText("1 of 3")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Second/ }).getAttribute("aria-pressed"),
  ).toBe("true");
});

test("a status move between groups keeps the selected ticket, its draft, and focus", async () => {
  let tickets: (Omit<ReturnType<typeof bulkTicket>, "availability"> & {
    availability: string | null;
  })[] = [bulkTicket(1)];
  await renderBulk({
    find_tickets: () => tickets,
    show_ticket: () => tickets[0],
    count_tickets: () =>
      counted({ [tickets[0]?.status === "Done" ? "done" : "todo"]: 1 }),
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await act(async () => {});
  const title = screen.getByRole("textbox", { name: "Title" });
  title.focus();
  fireEvent.change(title, { target: { value: "My unsaved title" } });
  tickets = [{ ...bulkTicket(1), status: "Done", availability: null }];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Todo" })).toBeNull();
  expect(
    screen.getByRole("button", { name: /First/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Title" }),
  );
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "My unsaved title",
  );
});

test("a group's Add action starts a ticket in that status", async () => {
  await renderBulk({
    find_tickets: () => [
      bulkTicket(1, { status: "In review", availability: null }),
    ],
    count_tickets: counted({ in_review: 1 }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Add In review ticket" }));
  await act(async () => {});
  const dialog = screen.getByRole("dialog", { name: "New ticket" });
  expect(
    within(dialog).getByRole("combobox", { name: "Status: In review" }),
  ).toBeTruthy();
});

test("the Duplicate group's Add action chooses a ticket and then reviews its canonical ticket", async () => {
  await renderBulk({
    find_tickets: () => [
      bulkTicket(1, { status: "Duplicate", availability: null }),
    ],
    count_tickets: counted({ duplicate: 1 }),
    search_tickets: () => [bulkTicket(2)],
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Duplicate ticket" }));
  await act(async () => {});
  const dialog = screen.getByRole("dialog", {
    name: "Mark a ticket as duplicate",
  });
  fireEvent.change(
    within(dialog).getByLabelText("Search tickets by title or reference"),
    { target: { value: "second" } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  fireEvent.click(within(dialog).getByRole("option", { name: /Second/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  await act(async () => {});
  const review = screen.getByRole("dialog", {
    name: "Mark T-KQ2 as a duplicate",
  });
  expect(
    within(review).getByText(/T-KQ2 keeps its description and history/),
  ).toBeTruthy();
  // The cursor is where the next answer goes, not on the dialog's frame.
  expect(document.activeElement).toBe(
    within(review).getByLabelText("Canonical ticket reference"),
  );
  // One flow: Cancel, and a primary that waits for the canonical ticket.
  expect(within(review).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(
    (
      within(review).getByRole("button", {
        name: "Mark duplicate",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // Nothing is marked until the review names a canonical ticket.
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "change_ticket",
    expect.anything(),
  );
});

test("an exact reference leads the matches in the mark-duplicate search", async () => {
  await renderBulk({
    find_tickets: () => [
      bulkTicket(1, { status: "Duplicate", availability: null }),
    ],
    count_tickets: counted({ duplicate: 1 }),
    search_tickets: () => [bulkTicket(2)],
    show_ticket: () => bulkTicket(3),
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Duplicate ticket" }));
  await act(async () => {});
  const dialog = screen.getByRole("dialog", {
    name: "Mark a ticket as duplicate",
  });
  fireEvent.change(
    within(dialog).getByLabelText("Search tickets by title or reference"),
    { target: { value: "T-KQ3" } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(within(dialog).getAllByRole("option")[0]?.textContent).toContain(
    "T-KQ3",
  );
});

test("Next at the end of a page opens the first ticket of the next page", async () => {
  const page = (offset: number, size: number) =>
    Array.from({ length: size }, (_, index) => ({
      ...bulkTicket(1),
      id: String(offset + index + 1),
      reference: `T-KQ${offset + index + 1}`,
      title: `Ticket ${offset + index + 1}`,
    }));
  const rows = (offset: number) => page(offset, offset === 0 ? 50 : 10);
  const position = () =>
    document.querySelector(".list-position-text")?.textContent;
  let offset = 0;
  await renderBulk({
    find_tickets: (args: { filter: { offset: number } }) => {
      offset = args.filter.offset;
      return rows(offset);
    },
    show_ticket: (args: { reference: string }) => ({
      ...bulkTicket(1),
      id: args.reference,
      reference: args.reference,
      title: args.reference,
    }),
    count_tickets: counted({ todo: 60 }),
  });
  fireEvent.click(screen.getByRole("button", { name: /Ticket 50/ }));
  await act(async () => {});
  expect(position()).toBe("50 of 60");
  const nextTicket = screen.getByRole("button", { name: "Next ticket" });
  nextTicket.focus();
  fireEvent.click(nextTicket);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(offset).toBe(50);
  expect(position()).toBe("51 of 60");
  // Keyboard focus stays on the control across the page edge.
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Next ticket" }),
  );
  expect(
    screen
      .getByRole("button", { name: /Ticket 51/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("pressing Next on the last page keeps focus in the pagination, on Previous", async () => {
  const all = Array.from({ length: 50 }, (_, index) => ({
    ...bulkTicket(1),
    id: String(index + 1),
    reference: `T-KQ${index + 1}`,
  }));
  await renderBulk({
    find_tickets: (args: { filter: { offset: number } }) =>
      args.filter.offset === 0
        ? all
        : [{ ...bulkTicket(1), id: "51", reference: "T-KQ51" }],
    show_ticket: () => all[0],
    count_tickets: () => counted({ todo: 51 }),
  });
  const next = screen.getByRole("button", { name: "Next" });
  next.focus();
  fireEvent.click(next);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect((next as HTMLButtonElement).disabled).toBe(true);
  // Never the document root: the person can keep paging with the keyboard.
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Previous" }),
  );
});

test("a later page that empties moves back to the last page that exists", async () => {
  const all = Array.from({ length: 50 }, (_, index) => ({
    ...bulkTicket(1),
    id: String(index + 1),
    reference: `T-KQ${index + 1}`,
    title: `Ticket ${index + 1}`,
  }));
  let total = 51;
  const offsets: number[] = [];
  await renderBulk({
    find_tickets: (args: { filter: { offset: number } }) => {
      offsets.push(args.filter.offset);
      if (args.filter.offset === 0) return all;
      return total > 50
        ? [{ ...bulkTicket(1), id: "51", reference: "T-KQ51" }]
        : [];
    },
    show_ticket: () => all[0],
    count_tickets: () => counted({ todo: total }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(offsets.at(-1)).toBe(50);
  // The only ticket on page 2 leaves the result (trashed, or closed by an agent).
  total = 50;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(offsets.at(-1)).toBe(0);
  expect(
    screen.getByText("50", { selector: '.ui-pane-header [data-slot="count"]' }),
  ).toBeTruthy();
  expect(screen.queryByText(/Your workspace is ready/)).toBeNull();
});

test.each(["ticket", "document", "plan"] as const)(
  "returns to workspace graph filters after opening a %s",
  async (kind) => {
    const ticket = bulkTicket(1);
    await renderBulk({
      find_tickets: () => [ticket],
      show_ticket: () => ticket,
      workspace_graph: () => ({
        node_tags: {},
        total: 1,
        nodes: [
          {
            id: "1",
            kind,
            label: "T-KQ1 · First",
            ticket_reference: kind === "ticket" ? "T-KQ1" : null,
            state: "Todo",
            trashed: false,
            activity_detail: false,
          },
        ],
        edges: [],
        next_cursor: null,
        omitted: false,
        omitted_groups: [],
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Workspace graph" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "First" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "T-KQ1 · First" }).at(-1)!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Open (ticket|item)$/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Back to workspace graph" }),
    );
    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe(
      "First",
    );
  },
);

test("a sidebar view leaves an open workspace graph", async () => {
  const ticket = bulkTicket(1);
  await renderBulk({
    find_tickets: () => [ticket],
    show_ticket: () => ticket,
    workspace_graph: () => ({
      node_tags: {},
      total: 0,
      nodes: [],
      edges: [],
      next_cursor: null,
      omitted: false,
      omitted_groups: [],
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Workspace graph" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("region", { name: "Workspace graph" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All tickets" }));
  expect(screen.queryByRole("region", { name: "Workspace graph" })).toBeNull();
  expect(screen.queryByText("Back to workspace graph")).toBeNull();
});

test("the sidebar collapses to named icons, expands again, and remembers the choice", async () => {
  const ticket = bulkTicket(1);
  const handlers = { find_tickets: () => [ticket], show_ticket: () => ticket };
  await renderBulk(handlers);
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  for (const name of ["Documents", "Workspace graph", "Trash", "Settings"])
    expect(screen.getByRole("button", { name })).toBeTruthy();
  expect(screen.getByRole("button", { name: "New ticket" })).toBeTruthy();
  cleanup();
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
});

test("Ctrl+B belongs to the editors and never toggles the sidebar", async () => {
  const ticket = bulkTicket(1);
  await renderBulk({ find_tickets: () => [ticket], show_ticket: () => ticket });
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "b", metaKey: true });
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
});

test("a failed save of the sidebar state says so and leaves the sidebar as it was", async () => {
  const ticket = bulkTicket(1);
  await renderBulk({ find_tickets: () => [ticket], show_ticket: () => ticket });
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("quota");
    });
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  setItem.mockRestore();
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn't save the sidebar state",
  );
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
});

test("a narrow window keeps the sheet and offers no collapse button", async () => {
  narrowViewport = true;
  await renderBulk({});
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
});

test("opening the workspace graph from Plans does not stack the Plans list", async () => {
  const ticket = bulkTicket(1);
  await renderBulk({
    find_tickets: () => [ticket],
    show_ticket: () => ticket,
    workspace_graph: () => ({
      node_tags: {},
      total: 0,
      nodes: [],
      edges: [],
      next_cursor: null,
      omitted: false,
      omitted_groups: [],
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Plans" }));
  expect(screen.getByRole("heading", { name: "Plans" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Workspace graph" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("region", { name: "Workspace graph" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Plans" })).toBeNull();
});

test("returns to local graph state after opening an item", async () => {
  const ticket = bulkTicket(1);
  const node = {
    id: "1",
    kind: "ticket",
    label: "T-KQ1 · First",
    ticket_reference: "T-KQ1",
    state: "Todo",
    trashed: false,
    activity_detail: false,
  };
  await renderBulk({
    find_tickets: () => [ticket],
    show_ticket: () => ticket,
    workspace_graph: () => ({
      node_tags: {},
      total: 1,
      nodes: [node],
      edges: [],
      next_cursor: null,
      omitted: false,
      omitted_groups: [],
    }),
    context_graph_expanded: () => ({
      center: "1",
      nodes: [node],
      edges: [],
      omitted: false,
      omitted_groups: [],
      continuations: [],
      hidden_details: false,
      max_nodes: 100,
      max_edges: 300,
      max_work: 1000,
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Workspace graph" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(
    screen.getAllByRole("button", { name: "T-KQ1 · First" }).at(-1)!,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Show only its neighbors" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(
    screen.getByRole("switch", { name: "Include update details" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Open item" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Back to context graph" }),
  );
  expect(
    screen
      .getByRole("switch", { name: "Include update details" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("opens Capture from anywhere with the global shortcut", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    bridgeDefault(command),
  );
  render(<App />);
  fireEvent.keyDown(window, { key: "N", shiftKey: true, ctrlKey: true });
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

test("the ticket detail bounds its height so the document and rail can scroll on their own", async () => {
  vi.useFakeTimers();
  const ticket = {
    id: "1",
    reference: "T-KQ1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    return command === "count_tickets" ? bridgeDefault(command) : [];
  });
  const { container } = render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  const panel =
    container.querySelector<HTMLElement>(".ticket-detail")!.parentElement!;
  // The panel clips; if it scrolled, its child would have no bounded height.
  expect(panel.style.overflow).toBe("hidden");
  expect(panel.style.display).toBe("flex");
  const detail = panel.querySelector<HTMLElement>(".ticket-detail")!;
  const bounded = detail.querySelectorAll(".detail-scroll");
  expect(bounded).toHaveLength(1);
  expect(bounded[0]!.parentElement).toBe(detail);
  // The document column and the rail are siblings, each scrolling by its own
  // overflow (styles.css) once the pane is wide enough for both.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const content = bounded[0]!.querySelector<HTMLElement>(".detail-content")!;
  expect(content.querySelector(":scope > .detail-document")).toBeTruthy();
  expect(content.querySelector(":scope > .ticket-properties")).toBeTruthy();
});

test("the folded sidebar opens Projects and Plans as one menu each", async () => {
  const ticket = bulkTicket(1);
  await renderBulk({ find_tickets: () => [ticket], show_ticket: () => ticket });
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  // The rail holds one entry per group, not a row per project or Plan.
  expect(screen.queryByRole("button", { name: "All projects" })).toBeNull();
  await openManageMenu("Projects", "All projects");
  expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
  await openManageMenu("Plans", "All Plans");
  expect(screen.getByRole("heading", { name: "Plans" })).toBeTruthy();
});

test("every icon on the folded rail names itself in a tooltip", async () => {
  const ticket = bulkTicket(1);
  await renderBulk({ find_tickets: () => [ticket], show_ticket: () => ticket });
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  const rail = document.querySelector<HTMLElement>(".sidebar")!;
  const unnamed = within(rail)
    .getAllByRole("button")
    .filter((button) => {
      // Shell SH-07: Attachments had no tooltip on the folded rail.
      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => button.focus());
      const shown = screen
        .queryAllByRole("tooltip")
        .some((tip) => tip.textContent?.trim());
      act(() => button.blur());
      return !shown;
    })
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);
  expect(unnamed).toEqual([]);
});
