import type { Ticket } from "@/lib/api/client";
import {
  reportWorkspaceFailure,
  clearWorkspaceFailure,
} from "@/lib/workspace-state";
// @vitest-environment jsdom
import { chooseFilter } from "@/test/filters";
import { setPreference } from "@/lib/preferences";
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
import { syncStatus, syncSettings } from "@/features/sync/sync-fixtures";

class ResizeObserverStub {
  constructor(private callback: ResizeObserverCallback) {}
  // The Tickets workspace stacks its panes when the content panel is narrow.
  observe(target: Element) {
    if (ticketListWidth !== null && target.classList.contains("ticket-rows"))
      this.callback(
        [{ contentRect: { width: ticketListWidth } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
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
Element.prototype.scrollIntoView = () => {};

let narrowViewport = false;
let ticketListWidth: number | null = null;
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
      return tickets.map((ticket) => ({
        ticket,
        latest_update:
          (ticket as { progress_summary?: unknown }).progress_summary ?? null,
      }));
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
  ticketListWidth = null;
  clearWorkspaceFailure();
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
  fireEvent.keyDown(
    await screen.findByRole("button", { name: "More library actions" }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Storage settings" }),
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
      if (command === "change_ticket")
        throw { code: "failed", message: "Keep draft for this test" };
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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Unfinished title",
  );
  expect(screen.getByText("Not in the current results")).toBeTruthy();
  listVisible = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.keyDown(document.body, { key: "r" });
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
  fireEvent.click(screen.getByRole("button", { name: "Back to Projects" }));
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
  await chooseFilter("Status", "Todo");
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
  expect(screen.queryByText("Not in the current results")).toBeNull();
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

test("first run shows the title and one New ticket action, no tools over nothing", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "count_tickets" ? bridgeDefault(command) : [],
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // The ticket list's header; hidden views (Documents) keep theirs mounted.
  const header = document
    .getElementById("tickets-heading")!
    .closest<HTMLElement>('[data-slot="pane-header"]')!;
  expect(within(header).getByRole("heading").textContent).toBe("All tickets");
  // S20: no count, Refresh, Filters or Display act on an empty workspace.
  expect(within(header).queryAllByRole("button")).toHaveLength(0);
  expect(header.querySelector('[data-slot="count"]')).toBeNull();
  const action = screen.getAllByRole("button", { name: "New ticket" })[1]!;
  expect(action.getAttribute("aria-keyshortcuts")).toBe("C");
});

test("Settings' way back names the view it returns to", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  // Shell SH-21: it said "Back to tickets" whatever the origin.
  fireEvent.click(screen.getByRole("button", { name: "Back to Attachments" }));
  expect(screen.getByRole("heading", { name: "Attachments" })).toBeTruthy();
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
  bridge.invoke.mockImplementation((command: string) =>
    command === "find_tickets" ? [bulkTicket(1)] : bridgeDefault(command),
  );
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
  // One ticket: an empty workspace has no Refresh (S20).
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string; reference?: string }) =>
      command === "find_tickets"
        ? unfilteredOnly(args)
        : bridgeDefault(command, args),
  );
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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
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
  // The selected row keeps its old group while its glyph reflects saved data.
  expect(screen.getByRole("heading", { name: "Todo" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Done" })).toBeNull();
});

test("clears additional filters while preserving the selected Plan", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string }) => {
      if (command === "list_plans")
        return [{ id: "e1", name: "Launch", archived: false }];
      if (command === "list_projects" || command === "find_tickets") return [];
      if (command === "show_plan") {
        const view = bridgeDefault(command, args) as { plan: object };
        return { ...view, plan: { ...view.plan, name: "Launch" } };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await chooseFilter("Status", "Todo");
  expect(
    screen.getByRole("button", { name: "Remove Status filter" }),
  ).toBeTruthy();
  fireEvent.click(
    within(screen.getByLabelText("Active filters")).getByRole("button", {
      name: "Clear filters",
    }),
  );
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Remove Status filter" }),
  ).toBeNull();
});

test("multiple tag filters count as one active dimension and clear together", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "find_tickets") return unfilteredOnly(args);
    if (command === "search_tags") return ["bug", "ui"];
    return bridgeDefault(command);
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await chooseFilter("Tags", "bug");
  await chooseFilter("Tags", "ui");
  expect(
    screen.getByRole("button", { name: "Filters, 1 active" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Active filters").textContent).toContain(
    "Tagsbug, ui",
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!,
  );
  expect(screen.queryByLabelText("Active filters")).toBeNull();
});

test("a filter applies live and counts N of M beside the title", async () => {
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
  await chooseFilter("Status", "Todo");
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
  // Choosing a value closes the menu; nothing docks over the detail pane.
  expect(screen.queryByRole("menu")).toBeNull();
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
  await chooseFilter("Status", "Todo");
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
  expect(screen.getByRole("button", { name: /Second/ })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
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

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // The line keeps its place; the cause waits under Details.
  expect(screen.getByText(/Can’t refresh/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(cause)).toBeTruthy();
  expect(screen.getByRole("button", { name: /First/ })).toBe(row);

  missing = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
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
  // The menu that started the change is gone; focus goes back to the list.
  expect(document.activeElement?.classList.contains("ticket-row")).toBe(true);
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
  expect(
    within(screen.getByRole("region", { name: "Bulk edit" })).getByRole(
      "alert",
    ),
  ).toBe(alert);
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
    search_tags: ["needs-review", "ui"],
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
    within(dialog).getByRole("option", { name: "needs-review" }),
  ).toBeTruthy();
  expect(within(dialog).queryByText("No tags yet")).toBeNull();
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
  // Every selected ticket is Todo: a check, and no "both" or "all" word.
  expect(todo.textContent).toBe("Todo");
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
    screen
      .getByRole("button", { name: "Clear selection" })
      .getAttribute("aria-keyshortcuts"),
  ).toBe("Escape");
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
      if (command === "find_tickets") return [bulkTicket(1)];
      if (command === "list_projects" || command === "list_plans") return [];
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
  const unreadInbox = screen.getByRole("button", { name: "Inbox, 3 unread" });
  expect(unreadInbox.querySelector('[data-tone="unread"]')).toBeTruthy();
  expect(unreadInbox.querySelector('[data-tone="attention"]')).toBeNull();
  expect(unreadInbox.querySelector(".sidebar-count")?.textContent).toBe("");
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

test("the narrow navigation trigger sits in the view's header and gets focus back when the sheet closes", async () => {
  vi.useFakeTimers();
  narrowViewport = true;
  bridge.invoke.mockImplementation(async () => []);
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  // Shell SH-16: in the header's leading slot, not a 48px bar above it.
  expect(trigger.closest('[data-slot="pane-header"]')).not.toBeNull();
  expect(document.querySelector(".shell-row")).toBeNull();
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

test("a selection ends when the filters change, and the bar can be skipped to", async () => {
  await renderBulk({ find_tickets: () => [bulkTicket(1), bulkTicket(2)] });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
  const skip = screen.getByRole("link", { name: "Skip to selection actions" });
  fireEvent.click(skip);
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Bulk edit" }),
  );
  await chooseFilter("Status", "Todo");
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
  expect(
    scroller?.contains(
      screen.getByRole("button", { name: "Show 50 more tickets" }),
    ),
  ).toBe(true);
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
  // The Todo header counts all 119 in the result, not the one shown.
  expect(screen.getByText("119")).toBeTruthy();
  // One paging pattern: "Show 50 more" under the rows (P17).
  expect(
    screen.getByRole("button", { name: "Show 50 more tickets" }),
  ).toBeTruthy();
  expect(screen.queryByText(/Showing 1–2/)).toBeNull();
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

test("empty ticket scopes follow one header rule without redundant captions", async () => {
  await renderBulk({});
  for (const label of [/^All tickets/, /^Ready/, /^In progress/]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const header = document
      .getElementById("tickets-heading")!
      .closest<HTMLElement>('[data-slot="pane-header"]')!;
    expect(
      within(header).queryByRole("button", { name: "Filters" }),
    ).toBeNull();
    expect(
      within(header).queryByRole("button", { name: "Display" }),
    ).toBeNull();
  }
});

test("the source filter narrows list and counts together without a header Refresh", async () => {
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
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
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
  expect(screen.getByRole("heading", { name: "Todo" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Done" })).toBeNull();
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
  fireEvent.click(
    screen.getByRole("button", { name: "Mark a ticket as duplicate…" }),
  );
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
  fireEvent.click(
    screen.getByRole("button", { name: "Mark a ticket as duplicate…" }),
  );
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

test("Show more adds the next page under the rows and keeps the selection", async () => {
  const all = Array.from({ length: 51 }, (_, index) => ({
    ...bulkTicket(1),
    id: String(index + 1),
    reference: `T-KQ${index + 1}`,
    title: `Ticket ${index + 1}`,
  }));
  await renderBulk({
    find_tickets: (args: { filter: { offset: number } }) =>
      all.slice(args.filter.offset, args.filter.offset + 50),
    show_ticket: () => all[0],
    count_tickets: () => counted({ todo: 51 }),
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  const more = screen.getByRole("button", { name: "Show 1 more tickets" });
  more.focus();
  fireEvent.click(more);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByRole("button", { name: /Ticket 51/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
  // Focus moves to the first new row, never to the document root (BD-09).
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /Ticket 51/ }),
  );
  // Showing more is not a new view: the selection stays.
  expect(screen.getByText("1 selected")).toBeTruthy();
});

test("Select all reaches every matching ticket, beyond the listed page (list B-02)", async () => {
  const all = Array.from({ length: 51 }, (_, index) => ({
    ...bulkTicket(1),
    id: String(index + 1),
    reference: `T-KQ${index + 1}`,
  }));
  await renderBulk({
    find_tickets: (args: { filter: { offset: number } }) =>
      all.slice(args.filter.offset, args.filter.offset + 50),
    count_tickets: () => counted({ todo: 51 }),
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("button", { name: "Select all 50" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Select all 51 matching" }),
  );
  await act(async () => {});
  expect(screen.getByText("51 selected")).toBeTruthy();
});

test("Shift-click selects the range from the last ticket toggled", async () => {
  await renderBulk({
    find_tickets: () => [bulkTicket(1), bulkTicket(2), bulkTicket(3)],
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ3" }), {
    shiftKey: true,
  });
  expect(screen.getByText("3 selected")).toBeTruthy();
});

test("switching to the board drops a selection the board cannot act on (list B-08)", async () => {
  await renderBulk({ find_tickets: () => [bulkTicket(1)] });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
  act(() => {
    setPreference("ticketLayout", "board");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  act(() => {
    setPreference("ticketLayout", "list");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.queryByText("1 selected")).toBeNull();
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
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
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
      screen.getByRole("button", { name: /^Open (T-KQ1|Document|Plan)$/ }),
    );
    const back = screen.getByRole("button", {
      name: "Back to workspace graph",
    });
    // Shell SH-14: a ReturnCrumb in the leading slot, not a strip over both panes.
    expect(
      back.closest('[data-slot="pane-header"], .shell-row'),
    ).not.toBeNull();
    fireEvent.click(back);
    if (!screen.queryByLabelText("Search"))
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
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
      connection_counts: { "1": 1 },
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
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  fireEvent.click(
    screen.getAllByRole("button", { name: "T-KQ1 · First" }).at(-1)!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Focus on this item" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(
    screen.getByRole("switch", { name: "Include update details" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Open T-KQ1" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));
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

test("the ticket detail bounds one document scroller and keeps properties in the document", async () => {
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
  // The property bar and connected context share one document scroller.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const content = bounded[0]!.querySelector<HTMLElement>(".detail-content")!;
  expect(content.querySelector(":scope > .detail-document")).toBeTruthy();
  expect(content.querySelector(":scope > .ticket-properties")).toBeNull();
  expect(
    content.querySelector(".detail-document .property-strip"),
  ).toBeTruthy();
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

test("command palette opens with navigation and returns focus on Escape", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  const opener = await screen.findByRole("button", { name: "Attachments" });
  opener.focus();
  fireEvent.keyDown(opener, { key: "k", ctrlKey: true });
  const input = await screen.findByRole(
    "combobox",
    {
      name: "Search tickets and destinations",
    },
    { timeout: 3000 },
  );
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole("option", { name: /Inbox/ })).toBeTruthy();
  await vi.waitFor(() =>
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy(),
  );
  const firstActive = input.getAttribute("aria-activedescendant");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await vi.waitFor(() =>
    expect(input.getAttribute("aria-activedescendant")).not.toBe(firstActive),
  );
  expect(
    document
      .getElementById(input.getAttribute("aria-activedescendant") ?? "")
      ?.getAttribute("role"),
  ).toBe("option");
  fireEvent.keyDown(input, { key: "Escape" });
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
});

test.each([
  ["i", "Inbox"],
  ["a", "All tickets"],
  ["r", "Ready"],
  ["d", "Documents"],
])("G then %s navigates to %s", async (key, label) => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: "Attachments" });
  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key });
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: new RegExp(`^${label}`) })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("G then C cannot create a ticket while Chat is off", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: "Attachments" });
  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "c" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each(["fv1", "T-FV11", "Unloaded title"])(
  "palette searches globally for %s and opens the selected Ticket",
  async (query) => {
    const found = bulkTicket(1, {
      reference: "T-FV11",
      title: "Unloaded title",
    });
    bridge.invoke.mockImplementation(
      (
        command: string,
        args?: { query?: string; id?: string; reference?: string },
      ) => {
        if (command === "search_tickets") {
          expect(args?.query).toBe(query);
          return [found];
        }
        if (command === "show_ticket") return found;
        return bridgeDefault(command, args);
      },
    );
    render(<App />);
    await screen.findByRole("button", { name: "Attachments" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.change(input, { target: { value: query } });
    const result = await screen.findByRole("option", { name: /T-FV11/ });
    expect(result.textContent).toContain("Unloaded title");
    expect(bridge.invoke).toHaveBeenCalledWith(
      "search_tickets",
      expect.objectContaining({ project: null, query }),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      await screen.findByRole("textbox", { name: "Title" }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

test.each(["Inbox", "Documents", "Plans", "Settings", "Attachments"])(
  "palette opens over %s and Enter goes to Ready",
  async (view) => {
    bridge.invoke.mockImplementation((command: string) =>
      command === "find_tickets" ? [bulkTicket(1)] : bridgeDefault(command),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: new RegExp(`^${view}$`) }),
    );
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole(
      "combobox",
      { name: "Search tickets and destinations" },
      { timeout: 3000 },
    );
    fireEvent.change(input, { target: { value: "Ready" } });
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("option", { name: /Ready/ })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /^Ready/ })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe("main-content"),
    );
  },
);

test("typing and overlays keep G keys; Mod K leaves a rich editor's link shortcut alone", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets")
      return [bulkTicket(1, { body: "A description" })];
    if (command === "show_ticket")
      return bulkTicket(1, { body: "A description" });
    return bridgeDefault(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /First/ }));
  const title = await screen.findByRole("textbox", { name: "Title" });
  title.focus();
  fireEvent.keyDown(title, { key: "g" });
  fireEvent.keyDown(title, { key: "i" });
  expect(
    screen
      .getByRole("button", { name: /^All tickets/ })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(
    await screen.findByRole("group", { name: "Read description" }),
  );
  const editor = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  await screen.findByRole("button", { name: "Link" });
  await act(async () => {
    editor.focus();
  });
  fireEvent.keyDown(editor, { key: "k", metaKey: true });
  expect(await screen.findByLabelText("Or link an address")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Go anywhere" })).toBeNull();
  fireEvent.keyDown(screen.getByLabelText("Or link an address"), {
    key: "Escape",
  });
  fireEvent.keyDown(editor, { key: "Escape" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Done editing" })).toBeNull(),
  );
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const input = await screen.findByRole(
    "combobox",
    { name: "Search tickets and destinations" },
    { timeout: 3000 },
  );
  fireEvent.keyDown(input, { key: "g" });
  fireEvent.keyDown(input, { key: "i" });
  expect(screen.getByRole("dialog", { name: "Go anywhere" })).toBeTruthy();
});

test("G then C opens Chats when the feature is enabled", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient } = await import("@/features/chats/mock-client");
  render(
    <ChatClientContext.Provider value={createMockChatClient({ enabled: true })}>
      <App />
    </ChatClientContext.Provider>,
  );
  const chatsEntry = await screen.findByRole("button", { name: "Chats" });
  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "c" });
  await vi.waitFor(() =>
    expect(chatsEntry.getAttribute("aria-current")).toBe("page"),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  expect(
    await screen.findByRole(
      "combobox",
      { name: "Search tickets and destinations" },
      { timeout: 3000 },
    ),
  ).toBeTruthy();
});

test.each([
  { key: "z" },
  { key: "Shift", shiftKey: true },
  { key: "g", repeat: true },
  { key: "g", isComposing: true },
])(
  "an interrupted G sequence does not navigate ($key)",
  async (interruption) => {
    bridge.invoke.mockImplementation(bridgeDefault);
    render(<App />);
    await screen.findByRole("button", { name: "Attachments" });
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, interruption);
    fireEvent.keyDown(document.body, { key: "i" });
    expect(
      screen
        .getByRole("button", { name: /^All tickets/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  },
);

test("a G sequence expires after one second", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: "Attachments" });
  vi.useFakeTimers();
  fireEvent.keyDown(document.body, { key: "g" });
  await act(async () => vi.advanceTimersByTimeAsync(1001));
  fireEvent.keyDown(document.body, { key: "i" });
  expect(
    screen
      .getByRole("button", { name: /^All tickets/ })
      .getAttribute("aria-current"),
  ).toBe("page");
});

test("focused Ticket status key opens a scoped palette and Undo restores the status", async () => {
  let current = bulkTicket(1, { reference: "T-FV1", title: "Palette target" });
  bridge.invoke.mockImplementation(
    (command: string, args?: { patch?: { status?: string } }) => {
      if (command === "find_tickets") return [current];
      if (command === "show_ticket") return current;
      if (command === "change_ticket") {
        current = { ...current, status: args?.patch?.status ?? current.status };
        return current;
      }
      return bridgeDefault(command);
    },
  );
  render(<App />);
  const row = await screen.findByRole("button", { name: /Palette target/ });
  row.focus();
  fireEvent.keyDown(row, { key: "s" });
  const input = await screen.findByRole("combobox", {
    name: "Search tickets and destinations",
  });
  expect(await screen.findByText("Status of T-FV1")).toBeTruthy();
  fireEvent.keyDown(input, { key: "4" });
  expect(await screen.findByText("Moved T-FV1 to Done")).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith(
    "change_ticket",
    expect.objectContaining({ reference: "T-FV1", patch: { status: "Done" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await vi.waitFor(() => expect(current.status).toBe("Todo"));
});

test.each([
  [
    "p",
    "Project",
    "Next project",
    "change_ticket",
    { patch: { project_id: "project-next" } },
  ],
  ["l", "Plan", "Next Plan", "set_plan", { plan: "plan-next" }],
  ["t", "Tags", "polish", "add_tag", { tag: "polish" }],
  ["h", "Reminder", "Tomorrow", "set_reminder", {}],
])(
  "focused Ticket %s key uses the existing %s mutation and Undo",
  async (key, scope, label, command, expected) => {
    const current = bulkTicket(1, {
      reference: "T-FV1",
      title: "Palette target",
    });
    bridge.invoke.mockImplementation(
      (name: string, args?: { reference?: string; id?: string }) => {
        if (name === "find_tickets") return [current];
        if (
          name === "show_ticket" ||
          name === "change_ticket" ||
          name === "set_plan" ||
          name === "add_tag" ||
          name === "remove_tag"
        )
          return current;
        if (name === "set_reminder") return null;
        if (name === "list_projects")
          return [
            {
              id: "project-next",
              name: "Next project",
              path: "/next",
              paths: ["/next"],
            },
          ];
        if (name === "list_plans")
          return [
            {
              id: "plan-next",
              name: "Next Plan",
              archived: false,
              purpose: "",
            },
          ];
        if (name === "search_tags") return ["polish"];
        return bridgeDefault(name, args);
      },
    );
    render(<App />);
    const row = await screen.findByRole("button", { name: /Palette target/ });
    row.focus();
    fireEvent.keyDown(row, { key });
    expect(await screen.findByText(`${scope} of T-FV1`)).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("option", { name: new RegExp(`^${label}`) }),
    );
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(bridge.invoke).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ reference: "T-FV1", ...expected }),
    );
    bridge.invoke.mockClear();
    fireEvent.click(undo);
    const undoCommand = command === "add_tag" ? "remove_tag" : command;
    await vi.waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        undoCommand,
        expect.objectContaining({ reference: "T-FV1" }),
      ),
    );
  },
);

function paletteTickets(prefix = "KQ", status = "Todo") {
  const tickets = [
    bulkTicket(1, {
      title: "Open Ticket",
      id: prefix === "KQ" ? "1" : `${prefix}1`,
      reference: `T-${prefix}1`,
    }),
    bulkTicket(2, {
      title: "Focused Ticket",
      status,
      duplicate_of: status === "Duplicate" ? `T-${prefix}1` : null,
      id: prefix === "KQ" ? "2" : `${prefix}2`,
      reference: `T-${prefix}2`,
    }),
  ];
  bridge.invoke.mockImplementation(
    (command: string, args?: { reference?: string; id?: string }) => {
      if (command === "find_tickets") return tickets;
      if (command === "show_ticket")
        return tickets.find((ticket) => ticket.reference === args?.reference);
      return bridgeDefault(command, args);
    },
  );
  return tickets;
}

test("palette actions come first, > excludes ticket search, and Tab and Backspace stay in the palette", async () => {
  paletteTickets();
  render(<App />);
  const row = await screen.findByRole("button", { name: /Focused Ticket/ });
  row.focus();
  fireEvent.keyDown(row, { key: "k", ctrlKey: true });
  const input = await screen.findByRole("combobox", {
    name: "Search tickets and destinations",
  });
  const status = await screen.findByRole("option", { name: /Change status/ });
  expect(screen.getAllByRole("option")[0]).toBe(status);
  fireEvent.keyDown(input, { key: "Tab" });
  expect(await screen.findByText("Status of T-KQ2")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(
    await screen.findByRole("option", { name: /Change status/ }),
  ).toBeTruthy();
  bridge.invoke.mockClear();
  fireEvent.change(input, { target: { value: "> status" } });
  expect(screen.getByRole("option", { name: /Change status/ })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Tickets" })).toBeNull();
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "search_tickets"),
  ).toBe(false);
});

test.each(["Todo", "Duplicate"])(
  "Duplicate from %s chooses the existing canonical-ticket review without a direct status write",
  async (status) => {
    paletteTickets("KQ", status);
    render(<App />);
    const row = await screen.findByRole("button", { name: /Focused Ticket/ });
    row.focus();
    fireEvent.keyDown(row, { key: "s" });
    fireEvent.click(
      await screen.findByRole("option", {
        name: /^(Mark as duplicate|Change canonical ticket)/,
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Mark T-KQ2 as a duplicate" }),
    ).toBeTruthy();
    expect(
      bridge.invoke.mock.calls.some(([command]) => command === "change_ticket"),
    ).toBe(false);
  },
);

test("copy reference prefers the focused row over the open Ticket", async () => {
  paletteTickets();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Open Ticket/ }));
  await screen.findByRole("textbox", { name: "Title" });
  const focused = screen.getByRole("button", { name: /Focused Ticket/ });
  focused.focus();
  fireEvent.keyDown(focused, { key: "C", ctrlKey: true, shiftKey: true });
  expect(writeText).toHaveBeenCalledWith("T-KQ2");
  fireEvent.keyDown(focused, { key: "p" });
  expect(await screen.findByText("Project of T-KQ2")).toBeTruthy();
});

test("property keys leave typing and existing dialogs alone", async () => {
  paletteTickets();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Open Ticket/ }));
  const title = await screen.findByRole("textbox", { name: "Title" });
  fireEvent.keyDown(title, { key: "s" });
  expect(screen.queryByRole("dialog")).toBeNull();
  title.blur();
  fireEvent.keyDown(document.body, { key: "c" });
  const dialog = await screen.findByRole("dialog");
  fireEvent.keyDown(dialog, { key: "h" });
  expect(
    screen.queryByRole("combobox", { name: "Search tickets and destinations" }),
  ).toBeNull();
});

test("reminder drill-in shares custom local-time scheduling with the existing reminder picker", async () => {
  paletteTickets();
  const original = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(
    (command: string, args?: { reference?: string }) =>
      command === "set_reminder" ? null : original(command, args),
  );
  render(<App />);
  const row = await screen.findByRole("button", { name: /Focused Ticket/ });
  row.focus();
  fireEvent.keyDown(row, { key: "h" });
  fireEvent.click(await screen.findByRole("option", { name: "Custom…" }));
  const field = await screen.findByLabelText("Date and time");
  fireEvent.change(field, { target: { value: "2030-01-01T12:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "set_reminder",
      expect.objectContaining({
        reference: "T-KQ2",
        dueAt: new Date(2030, 0, 1, 12).toISOString(),
      }),
    ),
  );
});

test.each([
  ["s", "Status"],
  ["p", "Project"],
  ["l", "Plan"],
  ["t", "Tags"],
  ["h", "Reminder"],
])(
  "board property key %s targets the focused card and returns focus after Escape",
  async (key, scope) => {
    paletteTickets();
    act(() => setPreference("ticketLayout", "board"));
    render(<App />);
    const card = (
      await screen.findAllByRole("button", { name: /Focused Ticket/ })
    ).find((button) => button.hasAttribute("data-board-reference"))!;
    card.focus();
    fireEvent.keyDown(card, { key });
    expect(await screen.findByText(`${scope} of T-KQ2`)).toBeTruthy();
    const input = screen.getByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.keyDown(input, { key: "Escape" });
    await vi.waitFor(() => expect(document.activeElement).toBe(card));
  },
);

test("R opens the update composer on the open Ticket", async () => {
  paletteTickets("UP");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Open Ticket/ }));
  await screen.findByRole("textbox", { name: "Title" });
  fireEvent.keyDown(document.body, { key: "r" });
  expect(
    await screen.findByRole("textbox", { name: /New update/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
});

test.each([
  ["s", "Status"],
  ["p", "Project"],
  ["l", "Plan"],
  ["t", "Tags"],
  ["h", "Reminder"],
])(
  "open Ticket property key %s is scoped to the Ticket",
  async (key, scope) => {
    paletteTickets();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Open Ticket/ }));
    await screen.findByRole("textbox", { name: "Title" });
    fireEvent.keyDown(document.body, { key });
    expect(await screen.findByText(`${scope} of T-KQ1`)).toBeTruthy();
  },
);

test("a read-only workspace disables palette mutations and R keeps the composer closed", async () => {
  paletteTickets("RO");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Open Ticket/ }));
  await screen.findByRole("textbox", { name: "Title" });
  act(() => reportWorkspaceFailure("workspace_read_only", "Read only"));
  fireEvent.keyDown(document.body, { key: "r" });
  expect(screen.queryByRole("textbox", { name: /New update/ })).toBeNull();
  fireEvent.keyDown(document.body, { key: "s" });
  const done = await screen.findByRole("option", { name: "Done" });
  expect(done.getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Search tickets and destinations" }),
    { key: "4" },
  );
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "change_ticket"),
  ).toBe(false);
});

test("palette offers the focused Ticket's linked Chat and opens that Chat", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient, chatState } =
    await import("@/features/chats/mock-client");
  const tickets = paletteTickets();
  const client = createMockChatClient({
    enabled: true,
    records: tickets.map((ticket) => ({
      kind: "ticket",
      id: ticket.id,
      reference: ticket.reference,
      title: ticket.title!,
      status: ticket.status,
    })),
    chats: [
      {
        chat: chatState({
          id: "linked-chat",
          title: "Polish focused Ticket",
          links: [
            {
              kind: "ticket",
              id: "2",
              reference: "T-KQ2",
              title: "Focused Ticket",
              status: "Todo",
            },
          ],
        }),
      },
    ],
  });
  const open = vi.spyOn(client, "openChat");
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  const row = await screen.findByRole("button", { name: /Focused Ticket/ });
  row.focus();
  fireEvent.keyDown(row, { key: "k", ctrlKey: true });
  fireEvent.click(
    await screen.findByRole("option", {
      name: /Open its Chat, “Polish focused Ticket”/,
    }),
  );
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith("linked-chat"));
});

test("sidebar jump opens the palette and footer icons navigate", async () => {
  bridge.invoke.mockImplementation((command: string) =>
    command === "list_trash" ? [] : bridgeDefault(command),
  );
  render(<App />);
  const jump = await screen.findByRole("button", {
    name: "Search or jump to…",
  });
  fireEvent.click(jump);
  expect(
    await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    }),
  ).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Trash" }));
  expect(await screen.findByRole("heading", { name: "Trash" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(
    await screen.findByRole("navigation", { name: "Settings sections" }),
  ).toBeTruthy();
});

test("read-only creation explains the disabled sidebar action and C cannot open it", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: "Search or jump to…" });
  act(() => reportWorkspaceFailure("workspace_read_only", "Read only"));
  const create = screen.getAllByRole("button", { name: "New ticket" })[0]!;
  expect(create.getAttribute("aria-disabled")).toBe("true");
  expect(create.getAttribute("aria-description")).toBe(
    "The workspace is read-only",
  );
  fireEvent.click(create);
  fireEvent.keyDown(document.body, { key: "c" });
  expect(screen.queryByRole("dialog", { name: "New ticket" })).toBeNull();
});

test("first-run sidebar omits zero counts and empty scope groups", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  const all = await screen.findByRole("button", { name: "All tickets" });
  expect(all.textContent?.trim()).toBe("All tickets");
  expect(
    screen.getByRole("button", { name: "Ready" }).textContent?.trim(),
  ).toBe("Ready");
  expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Plans" })).toBeNull();
  expect(screen.queryByText("Archived Plans")).toBeNull();
});

test("narrow header Search opens the shared palette outside the navigation sheet", async () => {
  narrowViewport = true;
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Search" }));
  expect(
    await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    }),
  ).toBeTruthy();
});

test("sidebar Plan progress uses full Plan counts and omits archived rows", async () => {
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans")
        return [
          { id: "P-1", name: "Board polish", archived: false },
          { id: "P-2", name: "Old plan", archived: true },
        ];
      if (command === "show_plan")
        return {
          plan: { id: args.id, name: "Board polish", archived: false },
          members: [],
          counts: {
            todo: 2,
            in_progress: 1,
            in_review: 1,
            done: 1,
            canceled: 2,
            duplicate: 1,
          },
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  const plan = await screen.findByRole("button", { name: /Board polish/ });
  await vi.waitFor(() => expect(plan.textContent).toContain("1/5"));
  expect(screen.queryByText("Old plan")).toBeNull();
});

test("footer destinations share their registered go-to sequences", async () => {
  bridge.invoke.mockImplementation((command: string) =>
    command === "list_trash" ? [] : bridgeDefault(command),
  );
  render(<App />);
  await screen.findByRole("button", { name: "Search or jump to…" });
  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "s" });
  expect(
    await screen.findByRole("navigation", { name: "Settings sections" }),
  ).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "x" });
  expect(await screen.findByRole("heading", { name: "Trash" })).toBeTruthy();
});

test("palette keeps New ticket and Capture reachable after removing the create menu", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Search or jump to…" }),
  );
  expect(
    await screen.findByRole("option", { name: /Capture a thought/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: /^New ticket/ }));
  const dialog = await screen.findByRole("dialog", { name: "New ticket" });
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      within(dialog).getByRole("textbox", { name: "Title" }),
    ),
  );
});

test("ledger uses the existing page update in Detailed and clears checkbox selection with Escape", async () => {
  const summary = {
    activity_id: "update-1",
    brief: { text: "Kept the drop slot until save", truncated: false },
    editing_agent: "codex",
    reported_at: "2026-11-15T00:00:00Z",
    updated_at: "2026-11-15T00:00:00Z",
    supporting_document_id: null,
  };
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "find_tickets")
      return [bulkTicket(1, { progress_summary: summary })];
    if (command === "count_tickets")
      return {
        total: 1,
        todo: 1,
        in_progress: 0,
        in_review: 0,
        done: 0,
        canceled: 0,
        duplicate: 0,
      };
    return bridgeDefault(command, args as undefined);
  });
  render(<App />);
  const row = await screen.findByRole("button", { name: /First/ });
  const pane = row.closest("section")!;
  expect(within(pane).queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(
    within(pane).queryByRole("button", { name: "Search tickets" }),
  ).toBeNull();
  expect(within(row).queryByText("Ready")).toBeNull();
  fireEvent.click(within(pane).getByRole("button", { name: "Display" }));
  fireEvent.click(await screen.findByRole("radio", { name: "Detailed" }));
  expect(await screen.findByText("Kept the drop slot until save")).toBeTruthy();
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "latest_update"),
  ).toHaveLength(0);
  fireEvent.keyDown(screen.getByRole("radio", { name: "Detailed" }), {
    key: "Escape",
  });
  const checkbox = screen.getByRole("checkbox", { name: "Select T-KQ1" });
  fireEvent.click(checkbox);
  checkbox.focus();
  fireEvent.keyDown(checkbox, { key: "Escape" });
  expect((checkbox as HTMLInputElement).checked).toBe(false);
});

test("Inbox shares Needs you counts with the sidebar and keeps E/H on the opened entry", async () => {
  const due = "2020-01-01T00:00:00Z";
  const ticket = bulkTicket(1, { status: "In review" });
  let read = false;
  await renderBulk({
    find_tickets: () => [ticket],
    show_ticket: () => ticket,
    reminder: () => due,
    sidebar_counts: () => ({
      unread_inbox: read ? 0 : 1,
      total: 1,
      ready: 0,
      in_progress: 0,
    }),
    inbox: () => [
      {
        id: 71,
        reference: "T-KQ1",
        title: "First",
        kind: "reminder",
        from_value: "",
        to_value: due,
        timestamp: new Date().toISOString(),
        read,
        editing_agent: null,
      },
    ],
    set_inbox_read: ({ read: next }: { read: boolean }) => {
      read = next;
    },
  });
  const inbox = screen.getByRole("button", {
    name: "Inbox, 1 entry needs you",
  });
  expect(inbox.querySelector('[data-tone="attention"]')).toBeTruthy();
  fireEvent.click(inbox);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const row = screen.getByRole("button", {
    name: /T-KQ1.*First.*Your reminder/,
  });
  fireEvent.click(row);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row, { key: "e" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(read).toBe(false);
  expect(
    screen.getByRole("button", { name: "Inbox, 1 entry needs you" }),
  ).toBeTruthy();
  fireEvent.keyDown(row, { key: "h" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("Snooze until")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: /command/i })).toBeNull();
});

test.each([
  [
    "Status: Todo",
    "Status",
    "Done",
    "change_ticket",
    { patch: { status: "Done" } },
  ],
  [
    "Project: No project",
    "Project",
    "Next project",
    "change_ticket",
    { patch: { project_id: "project-next" } },
  ],
  ["Plan: No Plan", "Plan", "Next Plan", "set_plan", { plan: "plan-next" }],
  ["Tags: No tags", "Tags", "polish", "add_tag", { tag: "polish" }],
  ["Remind me", "Reminder", "Tomorrow", "set_reminder", {}],
])(
  "the %s chip opens the shared %s drill-in and mutation",
  async (chip, scope, label, command, expected) => {
    const current = bulkTicket(1, {
      reference: "T-FV1",
      title: "Document target",
    });
    bridge.invoke.mockImplementation((name: string, args?: object) => {
      if (name === "find_tickets") return [current];
      if (
        ["show_ticket", "change_ticket", "set_plan", "add_tag"].includes(name)
      )
        return current;
      if (name === "set_reminder") return null;
      if (name === "list_projects")
        return [
          {
            id: "project-next",
            name: "Next project",
            path: "/next",
            paths: ["/next"],
          },
        ];
      if (name === "list_plans")
        return [
          { id: "plan-next", name: "Next Plan", archived: false, purpose: "" },
        ];
      if (name === "search_tags") return ["polish"];
      return bridgeDefault(name, args);
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Document target/ }),
    );
    if (scope === "Reminder") {
      expect(screen.queryByRole("button", { name: "Remind me" })).toBeNull();
      fireEvent.keyDown(
        await screen.findByRole("button", { name: "Add ticket property" }),
        { key: "ArrowDown" },
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Reminder" }),
      );
    } else fireEvent.click(await screen.findByRole("button", { name: chip }));
    const choices = await screen.findByText(`${scope} of T-FV1`);
    expect(choices.closest('[data-slot="popover-content"]')).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Go anywhere" })).toBeNull();
    const option = await screen.findByRole("option", {
      name: new RegExp(`^${label}`),
    });
    await vi.waitFor(() =>
      expect(option.getAttribute("aria-disabled")).not.toBe("true"),
    );
    fireEvent.click(option);
    await vi.waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        command,
        expect.objectContaining({ reference: "T-FV1", ...expected }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  },
);

test("a read-only workspace disables description editing from the button and E", async () => {
  paletteTickets();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Open Ticket/ }));
  const edit = await screen.findByRole("button", {
    name: "Add a description…",
  });
  act(() => reportWorkspaceFailure("workspace_read_only", "Read only"));
  expect(edit.hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(document.body, { key: "e" });
  expect(screen.queryByRole("button", { name: "Done editing" })).toBeNull();
  expect(
    screen.getByRole("textbox", { name: "Title" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("J and K swap the open document and Escape returns focus to its navigator row", async () => {
  paletteTickets();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Open Ticket/ }));
  await screen.findByRole("textbox", { name: "Title" });
  const reference = document.getElementById("detail-heading")!;
  reference.focus();
  fireEvent.keyDown(reference, { key: "j" });
  await vi.waitFor(() =>
    expect(document.getElementById("detail-heading")?.textContent).toBe(
      "T-KQ2",
    ),
  );
  fireEvent.keyDown(document.getElementById("detail-heading")!, {
    key: "Escape",
  });
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-ticket-reference")).toBe(
      "T-KQ2",
    ),
  );
});

test.each(["All tickets", "Plan"])(
  "%s keeps a narrow unselected list in the 36px ledger and uses the 52px navigator only for an open ticket",
  async (view) => {
    ticketListWidth = 480;
    const ticket = bulkTicket(1, {
      title: "Narrow list row",
      plan_id: "narrow-plan",
      tags: ["narrow"],
    });
    const plan = { id: "narrow-plan", name: "Narrow Plan", archived: false };
    bridge.invoke.mockImplementation((command: string, args?: object) => {
      if (command === "find_tickets") return [ticket];
      if (command === "show_ticket") return ticket;
      if (command === "list_plans") return [plan];
      if (command === "show_plan")
        return { plan, members: [ticket], counts: counted({ todo: 1 }) };
      if (command === "count_tickets") return counted({ todo: 1 });
      return bridgeDefault(command, args);
    });
    render(<App />);
    if (view === "Plan")
      fireEvent.click(
        await screen.findByRole("button", { name: /^Narrow Plan/ }),
      );
    const row = await screen.findByRole("button", { name: /Narrow list row/ });
    expect(row.closest("li")?.getAttribute("data-variant")).toBe("ledger");
    expect(within(row).getByText("T-KQ1")).toBeTruthy();
    expect(within(row).getByText("narrow")).toBeTruthy();
    expect(row.querySelector(".ticket-navigator-caption")).toBeNull();

    fireEvent.click(row);
    await screen.findByRole("textbox", { name: "Title" });
    expect(row.closest("li")?.getAttribute("data-variant")).toBe("navigator");
    expect(within(row).getByText("T-KQ1")).toBeTruthy();
    expect(row.querySelector(".ticket-navigator-caption")).toBeTruthy();
    expect(within(row).queryByText("narrow")).toBeNull();
    expect(row.querySelector(".ticket-row-state")).toBeNull();

    fireEvent.keyDown(document.getElementById("detail-heading")!, {
      key: "Escape",
    });
    await vi.waitFor(() =>
      expect(row.closest("li")?.getAttribute("data-variant")).toBe("ledger"),
    );
    expect(document.activeElement).toBe(row);
  },
);

test("a property drill-in highlights its current clearing value instead of the first project", async () => {
  const current = bulkTicket(1, {
    reference: "T-FV1",
    title: "Current project",
  });
  bridge.invoke.mockImplementation((name: string, args?: object) => {
    if (name === "find_tickets") return [current];
    if (name === "show_ticket") return current;
    if (name === "list_projects")
      return [
        {
          id: "project-next",
          name: "Next project",
          path: "/next",
          paths: ["/next"],
        },
      ];
    return bridgeDefault(name, args);
  });
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Current project/ }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Project: No project" }),
  );
  const clear = await screen.findByRole("option", { name: "No project" });
  await vi.waitFor(() =>
    expect(clear.getAttribute("aria-selected")).toBe("true"),
  );
});

test("sticky ledger keeps palette mutations in place until J leaves, then targets the newly focused ticket", async () => {
  let tickets = [
    bulkTicket(1, { title: "Sticky target", status: "In progress" }),
    bulkTicket(2, { title: "Next target", status: "In review" }),
    bulkTicket(3, { title: "Last target", status: "Todo" }),
  ];
  bridge.invoke.mockImplementation(
    (
      command: string,
      args?: {
        reference?: string;
        patch?: { status?: string };
      },
    ) => {
      if (command === "find_tickets") return tickets;
      if (command === "show_ticket")
        return tickets.find((ticket) => ticket.reference === args?.reference);
      if (command === "count_tickets")
        return counted({ in_progress: 1, in_review: 1, todo: 1 });
      if (command === "change_ticket") {
        tickets = tickets.map((ticket) =>
          ticket.reference === args?.reference
            ? { ...ticket, status: args?.patch?.status ?? ticket.status }
            : ticket,
        );
        return tickets.find((ticket) => ticket.reference === args?.reference);
      }
      return bridgeDefault(command);
    },
  );
  render(<App />);
  const target = await screen.findByRole("button", { name: /Sticky target/ });
  const list = target.closest("ul")!;
  const order = () =>
    Array.from(list.querySelectorAll(".ticket-row")).map((row) =>
      row.getAttribute("data-ticket-reference"),
    );
  const changeStatus = async (row: HTMLElement, key: string) => {
    fireEvent.keyDown(row, { key: "s" });
    const input = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.keyDown(input, { key });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };
  act(() => target.focus());
  await changeStatus(target, "3");
  expect(target.getAttribute("data-status")).toBe("In review");
  expect(order()).toEqual(["T-KQ1", "T-KQ2", "T-KQ3"]);
  expect(list.querySelector("li")?.getAttribute("data-status")).toBe(
    "In progress",
  );
  act(() => target.focus());
  await changeStatus(target, "4");
  expect(target.getAttribute("data-status")).toBe("Done");
  expect(order()).toEqual(["T-KQ1", "T-KQ2", "T-KQ3"]);
  act(() => target.focus());
  fireEvent.keyDown(target, { key: "j" });
  const next = screen.getByRole("button", { name: /Next target/ });
  expect(document.activeElement).toBe(next);
  expect(order()).toEqual(["T-KQ2", "T-KQ3", "T-KQ1"]);
  expect(list.querySelector("li")?.getAttribute("data-status")).toBe(
    "In review",
  );
  expect(target.closest("li")?.getAttribute("data-arriving")).toBe("true");
  await changeStatus(next, "4");
  expect(bridge.invoke).toHaveBeenCalledWith(
    "change_ticket",
    expect.objectContaining({ reference: "T-KQ2", patch: { status: "Done" } }),
  );
});

test.each([false, true])(
  "sticky navigator defers live changes while hovered and releases after idle (reduced motion %s)",
  async (reducedMotion) => {
    let tickets = [bulkTicket(1), bulkTicket(2, { status: "In progress" })];
    await renderBulk({
      find_tickets: () => tickets,
      show_ticket: ({ reference }: { reference: string }) =>
        tickets.find((ticket) => ticket.reference === reference),
      count_tickets: counted({ todo: 1, in_progress: 1 }),
    });
    const row = screen.getByRole("button", { name: /First/ });
    fireEvent.click(row);
    await act(async () => {});
    fireEvent.pointerEnter(row.closest("li")!);
    tickets = [{ ...tickets[0]!, status: "Done" }, tickets[1]!];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("heading", { name: "Todo" })).toBeTruthy();
    expect(row.getAttribute("data-status")).toBe("Done");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByRole("heading", { name: "Todo" })).toBeTruthy();
    narrowViewport = reducedMotion;
    fireEvent.pointerLeave(row.closest("li")!);
    expect(screen.queryByRole("heading", { name: "Todo" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
    expect(row.closest("li")?.getAttribute("data-arriving")).toBe("true");
    if (reducedMotion) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(row.closest("li")?.hasAttribute("data-arriving")).toBe(false);
    }
  },
);

test.each(["project", "Plan"])(
  "sticky Plan list retains a row removed by a saved %s change until leaving it",
  async (property) => {
    let current: Omit<
      ReturnType<typeof bulkTicket>,
      "project_id" | "plan_id"
    > & { project_id: string | null; plan_id: string | null } = bulkTicket(1, {
      project_id: "project-old",
      plan_id: "plan-old",
    });
    let included = true;
    const plan = {
      id: "plan-old",
      name: "Sticky Plan",
      archived: false,
      purpose: "Keep reading",
    };
    bridge.invoke.mockImplementation(
      (
        command: string,
        args?: {
          reference?: string;
          patch?: { project_id?: string };
          plan?: string;
        },
      ) => {
        if (command === "find_tickets") return included ? [current] : [];
        if (command === "show_ticket") return current;
        if (command === "list_plans")
          return [plan, { ...plan, id: "plan-next", name: "Next Plan" }];
        if (command === "show_plan")
          return { plan, members: [current], counts: counted({ todo: 1 }) };
        if (command === "list_projects")
          return [
            {
              id: "project-old",
              name: "Old project",
              paths: ["/old"],
              path: "/old",
            },
            {
              id: "project-next",
              name: "Next project",
              paths: ["/next"],
              path: "/next",
            },
          ];
        if (command === "count_tickets")
          return counted({ todo: included ? 1 : 0 });
        if (command === "change_ticket" || command === "set_plan") {
          current =
            property === "project"
              ? { ...current, project_id: args?.patch?.project_id ?? null }
              : { ...current, plan_id: args?.plan ?? null };
          included = false;
          return current;
        }
        return bridgeDefault(command);
      },
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Sticky Plan/ }),
    );
    const row = await screen.findByRole("button", { name: /First/ });
    fireEvent.click(row);
    await screen.findByRole("textbox", { name: "Title" });
    fireEvent.keyDown(row, { key: property === "project" ? "p" : "l" });
    const next = await screen.findByRole("option", {
      name: property === "project" ? /^Next project/ : /^Next Plan/,
    });
    fireEvent.click(next);
    await vi.waitFor(() => expect(included).toBe(false));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /First/ })).toBe(row);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("heading", { name: "Todo" }));
    expect(screen.queryByRole("button", { name: /First/ })).toBeNull();
  },
);

test("checked rows keep their live-update positions until idle even without an open detail", async () => {
  let tickets = [bulkTicket(1), bulkTicket(2, { status: "In progress" })];
  await renderBulk({
    find_tickets: () => tickets,
    count_tickets: counted({ todo: 1, in_progress: 1 }),
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  tickets = [{ ...tickets[0]!, status: "Done" }, tickets[1]!];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("heading", { name: "Todo" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /First/ }).getAttribute("data-status"),
  ).toBe("Done");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.queryByRole("heading", { name: "Todo" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
});

test("Plans cards join full counts, Flow-ordered Ready work, newest update and spec", async () => {
  const tickets = [
    bulkTicket(2, {
      title: "Ready second",
      availability: "Ready",
      updated_at: "2026-01-01T00:00:00Z",
    }),
    bulkTicket(9, {
      title: "Ready first",
      availability: "Ready",
      updated_at: "2026-02-01T00:00:00Z",
    }),
    bulkTicket(3, {
      title: "Waiting",
      availability: "Blocked",
      prerequisites: [
        {
          reference: "T-KQ9",
          title: "Ready first",
          status: "Todo",
          trashed: false,
          unresolved: true,
        },
      ],
    }),
  ];
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans")
        return [
          {
            id: "P-1",
            name: "Launch cards",
            archived: false,
            purpose: "Ship together",
          },
        ];
      if (command === "list_projects")
        return [
          { id: "project", name: "Desktop app", path: "/app", paths: ["/app"] },
        ];
      if (command === "show_plan")
        return {
          plan: {
            id: "P-1",
            name: "Launch cards",
            archived: false,
            spec_document_id: "spec",
          },
          counts: {
            todo: 3,
            in_progress: 2,
            in_review: 1,
            done: 4,
            canceled: 1,
            duplicate: 2,
          },
          members: tickets.map((t) => ({ ...t, project_id: "project" })),
          documents: [
            { id: "spec", heading: "Launch specification", trashed: false },
          ],
        };
      if (
        command === "find_tickets" &&
        (args.filter as { plan?: string }).plan === "P-1"
      )
        return tickets;
      if (command === "show_ticket")
        return tickets.find((ticket) => ticket.reference === args.reference);
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Plans" }));
  const cards = await screen.findByRole("list", { name: "Active Plans" });
  expect(await within(cards).findByText("4 of 10 done")).toBeTruthy();
  expect(within(cards).getByText("1 canceled, not counted")).toBeTruthy();
  expect(within(cards).getByText("2 duplicates, not counted")).toBeTruthy();
  expect(
    await within(cards).findByRole("button", { name: /T-KQ9 Ready first/ }),
  ).toBeTruthy();
  expect(within(cards).queryByText("Ready second")).toBeNull();
  expect(within(cards).getByText("Desktop app")).toBeTruthy();
  expect(
    within(cards).getByText("2 ready, 1 blocked", { exact: false }),
  ).toBeTruthy();
  expect(within(cards).getByText("Launch specification")).toBeTruthy();
  expect(cards.querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-02-01T00:00:00Z",
  );
  fireEvent.click(
    within(cards).getByRole("button", { name: /T-KQ9 Ready first/ }),
  );
  expect(await screen.findByRole("heading", { name: "T-KQ9" })).toBeTruthy();
});

test("New Plan is reachable from the palette and its registered page key", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Search or jump to…" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /^New Plan/ }));
  const dialog = await screen.findByRole("dialog", { name: "New Plan" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Search or jump to…" }));
  fireEvent.click(await screen.findByRole("option", { name: /^Plans/ }));
  fireEvent.keyDown(document.body, { key: "n" });
  expect(await screen.findByRole("dialog", { name: "New Plan" })).toBeTruthy();
});

test("Plans with no Ready work keep canceled-only progress explicit without inventing a time", async () => {
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans")
        return [{ id: "P-empty", name: "Stopped work", archived: false }];
      if (command === "show_plan")
        return {
          plan: { id: "P-empty", name: "Stopped work", archived: false },
          counts: {
            todo: 0,
            in_progress: 0,
            in_review: 0,
            done: 0,
            canceled: 2,
            duplicate: 0,
          },
          members: [],
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Plans" }));
  const cards = await screen.findByRole("list", { name: "Active Plans" });
  expect(await within(cards).findByText("0 of 0 done")).toBeTruthy();
  expect(await within(cards).findByText("No Ready tickets")).toBeTruthy();
  expect(within(cards).getByText("2 canceled, not counted")).toBeTruthy();
  expect(cards.querySelector("time")).toBeNull();
  fireEvent.click(
    within(cards).getByRole("button", { name: "Open Plan Stopped work" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Stopped work" }),
  ).toBeTruthy();
});

test("Plan page keeps its view switch in the header and summarizes all members", async () => {
  const plan = {
    id: "P-page",
    name: "Board polish",
    archived: false,
    purpose: "Make the board feel stable and fast.",
  };
  const ticket = bulkTicket(1, { plan_id: plan.id, project_id: "desktop" });
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "list_projects")
        return [
          { id: "desktop", name: "Desktop app", path: "/app", paths: ["/app"] },
        ];
      if (command === "find_tickets") return [ticket];
      if (command === "plan_dependency_graph")
        return {
          nodes: [],
          edges: [],
          truncated: false,
          max_nodes: 100,
          max_depth: 10,
          max_edges: 100,
          max_work: 1000,
          omitted_neighbors: false,
          omitted_edges: false,
        };
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 3, in_progress: 2, done: 1 }),
          members: [
            ticket,
            { ...ticket, reference: "T-KQ2", availability: "Ready" },
          ],
          documents: [],
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Board polish/ }));
  expect(await screen.findByText("1 of 6 done")).toBeTruthy();
  const summary = screen.getByRole("group", { name: "Plan context" });
  expect(
    within(summary).getByText("2 in progress · 3 to do, 2 ready"),
  ).toBeTruthy();
  expect(
    within(summary).getByRole("img", {
      name: "Board polish, 1 of 6 done, 2 moving",
    }),
  ).toBeTruthy();
  const switcher = screen.getByRole("radiogroup", { name: "Plan view" });
  const header = switcher.closest("header");
  expect(
    within(header!).getByRole("button", { name: "Add tickets" }),
  ).toBeTruthy();
  for (const name of ["Board", "Flow", "List"]) {
    fireEvent.click(within(switcher).getByRole("radio", { name }));
    expect(screen.getByRole("radiogroup", { name: "Plan view" })).toBe(
      switcher,
    );
    expect(switcher.closest("header")).toBe(header);
  }
  const row = screen.getByRole("button", { name: /First/ });
  expect(row.closest("li")?.textContent).toContain("Desktop app");
  expect(row.closest("li")?.textContent).not.toContain("Board polish");
});

test("ticket state lanes join ranked linked Chats without changing unrelated rows", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient } = await import("@/features/chats/mock-client");
  const client = createMockChatClient({ enabled: true });
  let notify = () => {};
  vi.spyOn(client, "subscribeOverview").mockImplementation((listener) => {
    notify = () =>
      listener({ needs_you: 0, unread: 0, app_icon: 0, working: 0 });
    return () => {};
  });
  const summaries = [
    ["working", "T-KQ1", "codex"],
    ["approval", "T-KQ1", "claude-code"],
    ["working", "T-KQ2", "codex"],
  ] as const;
  const list = vi.spyOn(client, "listChats").mockResolvedValue(
    summaries.map(([rank, reference, harness_id], i) => ({
      id: String(i),
      title: "Linked Chat",
      harness_id,
      harness_name: harness_id,
      tickets: [{ reference, status: "Todo" }],
      retention: "active",
      activity: "working",
      needs_you: rank === "approval",
      updated_at: "2026-11-15T00:00:00Z",
      status: {
        rank,
        unseen: false,
        word: rank === "approval" ? "Approval needed" : "Working",
      },
      muted: false,
    })),
  );
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "find_tickets")
      return [
        bulkTicket(1, {
          availability: "Blocked",
          prerequisites: [
            {
              reference: "T-KQ9",
              title: "Blocker",
              status: "Todo",
              trashed: false,
              unresolved: true,
            },
          ],
        }),
        bulkTicket(2),
        bulkTicket(3, { title: "Unrelated" }),
        bulkTicket(4, {
          title: "Duplicate ticket",
          status: "Duplicate",
          duplicate_of: "T-KQ9",
        }),
      ];
    if (command === "inbox")
      return [
        {
          id: 92,
          reference: "T-KQ3",
          title: "Unrelated",
          kind: "reminder",
          from_value: "",
          to_value: "2020-01-01T00:00:00Z",
          timestamp: "2020-01-01T00:00:00Z",
          read: false,
          editing_agent: null,
        },
      ];
    if (command === "reminder") return "2020-01-01T00:00:00Z";
    return bridgeDefault(command, args as undefined);
  });
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  const first = await screen.findByRole("button", { name: /First/ });
  await vi.waitFor(() =>
    expect(within(first).getByLabelText("Approval needed")).toBeTruthy(),
  );
  const second = screen.getByRole("button", { name: /Second/ });
  expect(within(second).getByLabelText("Working")).toBeTruthy();
  expect(
    within(within(second).getByLabelText("Working")).getByRole("img", {
      name: "codex",
    }),
  ).toBeTruthy();
  const unrelated = screen.getByRole("button", { name: /Unrelated/ });
  expect(within(unrelated).queryByText(/Working|Approval needed/)).toBeNull();
  expect(within(unrelated).getByLabelText("Reminder due")).toBeTruthy();
  expect(
    within(
      screen.getByRole("button", { name: /Duplicate ticket/ }),
    ).getByLabelText("Duplicate of T-KQ9"),
  ).toBeTruthy();
  list.mockResolvedValue([]);
  act(() => notify());
  await vi.waitFor(() =>
    expect(within(first).getByLabelText("Blocked by T-KQ9")).toBeTruthy(),
  );
  expect(within(second).queryByText("Working")).toBeNull();
});

test.each([
  ["claude", "0 0 256 257"],
  ["codex", "100 100 411 411"],
  ["release-bot", null],
])(
  "%s attribution uses known marks on rows, updates and Inbox entries",
  async (agent, viewBox) => {
    const at = "2026-11-15T00:00:00Z";
    const activity = {
      id: "agent-update",
      ticket_id: "1",
      brief: "Harness update",
      editing_agent: agent,
      reported_at: at,
      updated_at: at,
    };
    const ticket = bulkTicket(1, {
      status: "In review",
      progress_summary: {
        activity_id: activity.id,
        brief: { text: activity.brief, truncated: false },
        editing_agent: agent,
        reported_at: at,
        updated_at: at,
        supporting_document_id: null,
      },
    });
    bridge.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "find_tickets" || command === "show_ticket")
        return command === "find_tickets" ? [ticket] : ticket;
      if (command === "activity_feed") return [{ type: "authored", activity }];
      if (command === "inbox")
        return [
          {
            id: 91,
            reference: ticket.reference,
            title: ticket.title,
            kind: "activity",
            from_value: "",
            to_value: activity.brief,
            timestamp: at,
            read: false,
            editing_agent: agent,
          },
        ];
      return bridgeDefault(command, args as undefined);
    });
    const publisherMark = (element: Element) =>
      element.querySelector(".harness-mark svg")?.getAttribute("viewBox") ??
      null;
    render(<App />);
    const row = await screen.findByRole("button", { name: /First/ });
    expect(within(row).getByLabelText("Ready for review")).toBeTruthy();
    expect(publisherMark(row)).toBe(viewBox);
    fireEvent.click(row);
    const update = await screen.findByRole("article", {
      name: `Update by ${agent}`,
    });
    expect(within(update).getByText(agent)).toBeTruthy();
    expect(publisherMark(update.closest('[data-slot="comment-row"]')!)).toBe(
      viewBox,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    const entry = await screen.findByRole("button", {
      name: /T-KQ1.*First.*Harness update/,
    });
    expect(within(entry).getByText(agent)).toBeTruthy();
    expect(publisherMark(entry)).toBe(viewBox);
  },
);

test("description editing keeps its state row and floats controls outside the prose", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets")
      return [bulkTicket(1, { body: "A description" })];
    if (command === "show_ticket")
      return bulkTicket(1, { body: "A description" });
    return bridgeDefault(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /First/ }));
  const prose = await screen.findByText("A description");
  const stateRow = document.querySelector(".ticket-state-row");
  const stateText = stateRow?.textContent;
  fireEvent.click(prose);
  const editor = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  expect(document.querySelector(".ticket-state-row")).toBe(stateRow);
  expect(stateRow?.textContent).toBe(stateText);
  expect(screen.queryByText(/^Edit$/)).toBeNull();
  const bar = screen.getByRole("group", { name: "Edit controls" });
  expect(
    bar.contains(screen.getByRole("button", { name: "Done editing" })),
  ).toBe(true);
  expect(bar.closest(".editor-body")).toBeNull();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "Edit controls" })).toBeNull();
  expect(
    within(screen.getByRole("group", { name: "Read description" })).getByText(
      "A description",
    ),
  ).toBeTruthy();
  expect(document.querySelector(".ticket-state-row")).toBe(stateRow);
  const reading = screen.getByRole("group", { name: "Read description" });
  await vi.waitFor(() => expect(document.activeElement).toBe(reading));
  fireEvent.keyDown(reading, { key: "k", ctrlKey: true });
  expect(
    await screen.findByRole("dialog", { name: "Go anywhere" }),
  ).toBeTruthy();
});

test("floating save feedback retains a failed description draft and retries it", async () => {
  let stored = bulkTicket(1, { body: "- [ ] Keep this draft" });
  let failSave: (reason: Error) => void = () => {};
  let attempts = 0;
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "find_tickets") return [stored];
    if (command === "show_ticket") return stored;
    if (command === "change_ticket") {
      attempts += 1;
      if (attempts === 1)
        return new Promise((_resolve, reject) => {
          failSave = reject;
        });
      stored = { ...stored, ...(args as { patch: { body: string } }).patch };
      return stored;
    }
    return bridgeDefault(command, args as { id?: string; reference?: string });
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /First/ }));
  await screen.findByText("Keep this draft");
  fireEvent.keyDown(document.body, { key: "e" });
  const checkbox = await screen.findByRole("checkbox", {
    name: "Checklist item",
  });
  fireEvent.click(checkbox);
  const bar = screen.getByRole("group", { name: "Edit controls" });
  expect(await within(bar).findByText("Saving…")).toBeTruthy();
  await vi.waitFor(() => expect(attempts).toBe(1));
  await act(async () => failSave(new Error("Disk full")));
  expect(await within(bar).findByText("Not saved")).toBeTruthy();
  expect(
    screen.getByRole("checkbox", { name: "Checklist item" }),
  ).toHaveProperty("checked", true);
  expect(screen.getByText(/Disk full/)).toBeTruthy();
  fireEvent.click(within(bar).getByRole("button", { name: "Retry" }));
  expect(await within(bar).findByText("Saved")).toBeTruthy();
  expect(stored.body).toBe("- [x] Keep this draft");
  await vi.waitFor(() => expect(within(bar).queryByText("Saved")).toBeNull(), {
    timeout: 4000,
  });
  expect(
    within(bar).getByRole("button", { name: "Done editing" }),
  ).toBeTruthy();
});

test("Document sync metadata survives floating Saved feedback and waits for Drive confirmation", async () => {
  let stored = {
    id: "document-sync",
    title: "Sync safety",
    body: "Keep this thought",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    trashed: false,
  };
  let uploaded = false;
  let finishSave = () => {};
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "recent_documents")
      return [{ id: stored.id, heading: stored.title }];
    if (command === "open_document" || command === "show_document")
      return stored;
    if (command === "document_tags") return [];
    if (command === "document_version")
      return [stored.updated_at, stored.trashed];
    if (command === "sync_status")
      return syncStatus(
        uploaded
          ? {}
          : {
              state: "upload_pending",
              pending_uploads: [
                {
                  kind: "document",
                  id: stored.id,
                  reference: null,
                  title: stored.title,
                },
              ],
            },
      );
    if (command === "save_document") {
      stored = {
        ...stored,
        title: (args as { title: string }).title,
        updated_at: "2026-11-01T00:00:01Z",
      };
      return new Promise((resolve) => {
        finishSave = () => resolve(stored);
      });
    }
    return bridgeDefault(command, args as { id?: string; reference?: string });
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sync safety" }));
  const metadata = await screen.findByRole("status", {
    name: "Document sync status",
  });
  expect(metadata.textContent).toBe("Saved on this computer");
  const stateRow = metadata.parentElement!;
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Sync safety revised" },
  });
  const bar = screen.getByRole("group", { name: "Edit controls" });
  expect(await within(bar).findByText("Saving…")).toBeTruthy();
  expect(within(stateRow).queryByText("Synced to Drive")).toBeNull();
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "save_document",
      expect.objectContaining({ title: "Sync safety revised" }),
    ),
  );
  await act(async () => finishSave());
  expect(await within(bar).findByText("Saved")).toBeTruthy();
  expect(
    screen.getByRole("status", { name: "Document sync status" }).textContent,
  ).toBe("Saved on this computer");
  expect(within(stateRow).queryByText("Synced to Drive")).toBeNull();
  uploaded = true;
  expect(await within(stateRow).findByText("Synced to Drive")).toBeTruthy();
  await vi.waitFor(() => expect(within(bar).queryByText("Saved")).toBeNull(), {
    timeout: 4000,
  });
  expect(
    screen.getByRole("status", { name: "Document sync status" }).parentElement,
  ).toBe(stateRow);
  fireEvent.click(within(bar).getByRole("button", { name: "Done editing" }));
  expect(within(stateRow).getByText("Synced to Drive")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Edit controls" })).toBeNull();
});

test("Plan Flow uses all members, selects only incident edges, opens tickets and enters the scoped Workspace graph", async () => {
  const plan = { id: "P-flow", name: "Flow example", archived: false };
  const prerequisite = (reference: string) => ({
    reference,
    title: reference,
    status: "Todo",
    trashed: false,
    unresolved: true,
  });
  const tickets = [
    bulkTicket(14, {
      title: "Draggable ghost",
      plan_id: plan.id,
      availability: "Ready",
    }),
    bulkTicket(15, {
      title: "Drop indicator",
      plan_id: plan.id,
      availability: "Ready",
    }),
    bulkTicket(1, {
      title: "Stable columns",
      plan_id: plan.id,
      status: "In progress",
      availability: null,
      prerequisites: [prerequisite("T-KQ14"), prerequisite("T-KQ15")],
    }),
    bulkTicket(2, {
      title: "Keyboard sheet",
      plan_id: plan.id,
      availability: "Blocked",
      prerequisites: [prerequisite("T-KQ1")],
    }),
  ];
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const reference = this.getAttribute("aria-label")?.split(" ")[0];
      const index = reference === "T-KQ1" ? 1 : reference === "T-KQ2" ? 2 : 0;
      const x = index * 344;
      return {
        x,
        y: 0,
        left: x,
        right: x + 296,
        top: 0,
        bottom: 86,
        width: 296,
        height: 86,
        toJSON: () => ({}),
      };
    });
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "find_tickets")
        return Number(args.offset ?? 0) === 0 ? tickets : [];
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 3, in_progress: 1 }),
          members: tickets,
          documents: [],
        };
      if (command === "show_ticket")
        return (
          tickets.find((ticket) => ticket.reference === args.reference) ??
          tickets[0]
        );
      if (command === "workspace_graph")
        return {
          nodes: [
            {
              id: "outside-plan",
              kind: "document",
              label: "Unrelated outside item",
              state: null,
              trashed: false,
              activity_detail: false,
            },
            ...tickets.map((ticket) => ({
              id: ticket.id,
              kind: "ticket",
              label: ticket.title,
              state: ticket.status,
              trashed: false,
              activity_detail: false,
              ticket_reference: ticket.reference,
            })),
          ],
          edges: [],
          omitted: false,
          omitted_groups: [],
          next_cursor: null,
          total: 4,
          node_tags: {},
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Flow example/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Flow" }));
  const flow = await screen.findByRole("region", { name: "Plan Flow" });
  const now = within(flow).getByRole("region", { name: "Now" });
  expect(
    (await within(now).findAllByRole("button")).map((button) =>
      button.getAttribute("aria-label"),
    ),
  ).toEqual(["T-KQ15 Drop indicator", "T-KQ14 Draggable ghost"]);
  const next = within(flow).getByRole("region", { name: "Next" });
  const selected = within(next).getByRole("button", {
    name: /T-KQ1 Stable columns/,
  });
  fireEvent.click(selected);
  expect(flow.querySelectorAll("[data-hot]")).toHaveLength(3);
  const ready = within(now).getByRole("button", { name: /T-KQ15/ });
  fireEvent.click(ready);
  expect(flow.querySelectorAll("[data-hot]")).toHaveLength(1);
  fireEvent.keyDown(ready, { key: "j" });
  expect(document.activeElement?.getAttribute("aria-label")).toContain(
    "T-KQ14",
  );
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(await screen.findByRole("heading", { name: "T-KQ14" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Flow" }));
  const cardBeforeNavigation = await screen.findByRole("button", {
    name: "T-KQ15 Drop indicator",
  });
  cardBeforeNavigation.focus();
  fireEvent.keyDown(cardBeforeNavigation, { key: "g" });
  fireEvent.keyDown(cardBeforeNavigation, { key: "i" });
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: /^Inbox/ })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Flow example/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Flow" }));
  const graphCard = await screen.findByRole("button", {
    name: "T-KQ15 Drop indicator",
  });
  graphCard.focus();
  fireEvent.keyDown(graphCard, { key: "G", shiftKey: true });
  expect(await screen.findByText("Filtered to this Plan")).toBeTruthy();
  const workspace = screen.getByRole("region", { name: "Workspace graph" });
  expect(
    await within(workspace).findByText("4 tickets, 0 Documents"),
  ).toBeTruthy();
  expect(
    within(workspace)
      .getByRole("radio", { name: "Graph" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(within(workspace).queryByText("Unrelated outside item")).toBeNull();
  expect(bridge.invoke).toHaveBeenCalledWith(
    "workspace_graph",
    expect.objectContaining({
      request: expect.objectContaining({
        hydrate_only: true,
        visible_ids: expect.arrayContaining([
          plan.id,
          ...tickets.map((ticket) => ticket.id),
        ]),
      }),
    }),
  );
  rect.mockRestore();
});

test("Flow loads members beyond the first page before deriving blocking depth", async () => {
  const plan = { id: "P-large-flow", name: "Large flow", archived: false };
  const tickets: Ticket[] = Array.from({ length: 52 }, (_, index) => ({
    ...bulkTicket(index + 1),
    title: `Flow member ${index + 1}`,
    plan_id: plan.id,
    availability: "Ready",
  }));
  tickets[0] = {
    ...tickets[0]!,
    availability: "Blocked",
    prerequisites: [
      {
        reference: "T-KQ52",
        title: "Flow member 52",
        status: "Todo",
        trashed: false,
        unresolved: true,
      },
    ],
  };
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "find_tickets") {
        const filter = args.filter as { offset: number; limit: number };
        return tickets.slice(filter.offset, filter.offset + filter.limit);
      }
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 52 }),
          members: tickets,
          documents: [],
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Large flow/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Flow" }));
  const flow = await screen.findByRole("region", { name: "Plan Flow" });
  expect(
    await within(within(flow).getByRole("region", { name: "Now" })).findByRole(
      "button",
      { name: "T-KQ52 Flow member 52" },
    ),
  ).toBeTruthy();
  expect(
    within(within(flow).getByRole("region", { name: "Next" })).getByRole(
      "button",
      { name: "T-KQ1 Flow member 1" },
    ),
  ).toBeTruthy();
  expect(within(flow).getByText("Waits on T-KQ52")).toBeTruthy();
});

test("Workspace graph opens Graph, groups Plan members and keeps identical items in List", async () => {
  const plan = { id: "P-island", name: "Island example", archived: false };
  const tickets = [
    bulkTicket(1, { title: "Island member", plan_id: plan.id }),
    bulkTicket(2, { title: "Unplanned ticket" }),
  ];
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "find_tickets")
        return (args.filter as { plan?: string }).plan ? [tickets[0]] : tickets;
      if (command === "show_ticket")
        return tickets.find((ticket) => ticket.reference === args.reference);
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 1 }),
          members: [tickets[0]],
          documents: [],
        };
      if (command === "workspace_graph")
        return {
          nodes: [
            {
              id: plan.id,
              kind: "plan",
              label: plan.name,
              state: "Active",
              trashed: false,
              activity_detail: false,
            },
            ...tickets.map((ticket) => ({
              id: ticket.id,
              kind: "ticket",
              label: `${ticket.reference} · ${ticket.title}`,
              state: ticket.status,
              trashed: false,
              activity_detail: false,
              ticket_reference: ticket.reference,
            })),
          ],
          edges: [],
          omitted: false,
          omitted_groups: [],
          next_cursor: null,
          total: 3,
          node_tags: {},
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workspace graph" }),
  );
  const graph = screen.getByRole("region", { name: "Workspace graph" });
  expect(
    within(graph)
      .getByRole("radio", { name: "Graph" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    await within(graph).findByRole("button", {
      name: /T-KQ1 Island member/,
      hidden: true,
    }),
  ).toBeTruthy();
  expect(
    within(graph).getByRole("button", {
      name: /T-KQ2 Unplanned ticket/,
      hidden: true,
    }),
  ).toBeTruthy();
  expect(within(graph).getByText("1 ticket, 0 Documents")).toBeTruthy();
  expect(within(graph).getByText("Not in a Plan · 1")).toBeTruthy();
  fireEvent.click(within(graph).getByRole("radio", { name: "List" }));
  expect(
    within(graph).getByRole("button", {
      name: /T-KQ1 · Island member/,
      hidden: true,
    }),
  ).toBeTruthy();
  expect(
    within(graph).getByRole("button", {
      name: /T-KQ2 · Unplanned ticket/,
      hidden: true,
    }),
  ).toBeTruthy();
  expect(within(graph).getByText("3 items · 1 connection")).toBeTruthy();
  fireEvent.click(
    within(graph).getByRole("button", { name: "T-KQ2 · Unplanned ticket" }),
  );
  fireEvent.click(within(graph).getByRole("button", { name: "Center here" }));
  expect(
    within(graph)
      .getByRole("radio", { name: "Graph" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  const listChoice = within(graph).getByRole("radio", { name: "List" });
  fireEvent.click(listChoice);
  listChoice.focus();
  fireEvent.keyDown(listChoice, { key: "V", shiftKey: true });
  expect(
    within(graph)
      .getByRole("radio", { name: "Graph" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  const filterButton = within(graph).getByRole("button", { name: "Filter" });
  filterButton.focus();
  fireEvent.keyDown(filterButton, { key: "f" });
  expect(screen.getByLabelText("Search")).toBeTruthy();
});

test("Workspace graph retries an incomplete island and preserves members and mandatory links across hydration batches", async () => {
  const plan = {
    id: "P-complete-island",
    name: "Complete island",
    archived: false,
    spec_document_id: "spec-island",
  };
  const members: Ticket[] = Array.from({ length: 101 }, (_, index) => ({
    ...bulkTicket(index + 1),
    title: `Island ticket ${index + 1}`,
    plan_id: plan.id,
  }));
  members[0] = {
    ...members[0]!,
    prerequisites: [
      {
        reference: "T-KQ101",
        title: "Island ticket 101",
        status: "Todo",
        trashed: false,
        unresolved: true,
      },
    ],
  };
  let incomplete = true;
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "find_tickets") {
        const filter = args.filter as { offset: number; limit: number };
        return members.slice(filter.offset, filter.offset + filter.limit);
      }
      if (command === "show_ticket")
        return members.find((ticket) => ticket.reference === args.reference);
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 101 }),
          members,
          documents: [
            {
              id: "spec-island",
              heading: "Island specification",
              trashed: false,
            },
          ],
        };
      if (command === "workspace_graph") {
        const request = args.request as {
          hydrate_only: boolean;
          visible_ids: string[];
        };
        const all = [
          {
            id: plan.id,
            kind: "plan",
            label: plan.name,
            state: "Active",
            trashed: false,
            activity_detail: false,
          },
          {
            id: "spec-island",
            kind: "document",
            label: "Island specification",
            state: null,
            trashed: false,
            activity_detail: false,
          },
          ...members.map((ticket) => ({
            id: ticket.id,
            kind: "ticket",
            label: `${ticket.reference} · ${ticket.title}`,
            ticket_reference: ticket.reference,
            state: ticket.status,
            trashed: false,
            activity_detail: false,
          })),
        ];
        const nodes = request.hydrate_only
          ? all.filter(
              (node) =>
                request.visible_ids.includes(node.id) &&
                (!incomplete || node.id !== members[100]!.id),
            )
          : [];
        return {
          nodes,
          edges: [],
          omitted: false,
          omitted_groups: [],
          next_cursor: null,
          total: 103,
          node_tags: {},
        };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workspace graph" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  incomplete = false;
  const graph = screen.getByRole("region", { name: "Workspace graph" });
  expect(
    await within(graph).findByText("101 tickets, 1 Document"),
  ).toBeTruthy();
  fireEvent.click(within(graph).getByRole("radio", { name: "List" }));
  expect(
    within(graph).getByRole("button", { name: "T-KQ101 · Island ticket 101" }),
  ).toBeTruthy();
  expect(within(graph).getByText("103 items · 103 connections")).toBeTruthy();
  fireEvent.click(
    within(graph).getByRole("button", { name: "T-KQ1 · Island ticket 1" }),
  );
  expect(
    within(graph).getByRole("region", { name: "Blocked by" }),
  ).toBeTruthy();
  expect(
    within(graph).getByText(
      /Some connections across the 100-item graph limit are hidden/,
    ),
  ).toBeTruthy();
});
test.each([
  [true, "1"],
  [false, "2"],
  [true, "3"],
] as const)(
  "ticket agent strip and Inbox follow approval answer (focused: %s, choice: %s)",
  async (focused, choice) => {
    const { notificationClient } = await import("@/lib/api/notifications");
    const nativeNotifications = vi
      .spyOn(notificationClient, "notify")
      .mockImplementation(() => {});
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    try {
      const { ChatClientContext } = await import("@/features/chats/client");
      const { createMockChatClient, chatState } =
        await import("@/features/chats/mock-client");
      const tickets = paletteTickets();
      const client = createMockChatClient({
        enabled: true,
        chats: [
          {
            chat: chatState({
              id: "strip-chat",
              title: "Strip Chat",
              activity: "working",
              links: [
                {
                  kind: "ticket",
                  id: "2",
                  reference: "T-KQ2",
                  title: "Focused Ticket",
                  status: "Todo",
                },
              ],
            }),
          },
        ],
      });
      bridge.invoke.mockImplementation((command: string, args: unknown) =>
        command === "find_tickets"
          ? tickets
          : command === "show_ticket"
            ? tickets[1]
            : bridgeDefault(command, args as undefined),
      );
      render(
        <ChatClientContext value={client}>
          <App />
        </ChatClientContext>,
      );
      fireEvent.click(
        await screen.findByRole("button", { name: /Focused Ticket/ }),
      );
      const strip = await screen.findByRole("status", { name: "Ticket agent" });
      expect(within(strip).getByText(/is working on this/)).toBeTruthy();
      expect(
        await screen.findByRole("button", { name: "Chats, 1 working" }),
      ).toBeTruthy();
      expect(strip.closest(".ticket-agent-slot")).toBeTruthy();
      const slot = strip.closest(".ticket-agent-slot");
      act(() =>
        client.push("strip-chat", {
          kind: "steps",
          id: "step",
          at: "2026-11-16T00:00:00Z",
          steps: [
            {
              kind: "run",
              target: "npm test -- board",
              state: "running",
              started_at: "2026-11-16T00:00:00Z",
            },
          ],
        }),
      );
      expect(
        await within(strip).findByText(/Running npm test -- board/),
      ).toBeTruthy();
      expect(
        strip.querySelector('[aria-hidden="true"].text-muted-foreground'),
      ).toBeTruthy();
      expect(strip.getAttribute("aria-live")).toBe("polite");
      expect(strip.getAttribute("aria-atomic")).toBe("true");
      act(() => client.patch("strip-chat", { activity: "idle" }));
      await within(strip).findByRole("button", { name: "Open Chat" });
      expect(within(strip).queryByText(/is working on this/)).toBeNull();
      expect(strip.closest(".ticket-agent-slot")).toBe(slot);
      act(() =>
        client.push("strip-chat", {
          kind: "request",
          id: "approval",
          at: "2026-11-16T00:00:00Z",
          request: "approval",
          title: "wants to run",
          command: "npm test -- board",
          options: [
            { id: "allow", label: "Allow once" },
            { id: "session", label: "Allow for this session" },
            { id: "deny", label: "Decline" },
          ],
          state: "pending",
          free_text: false,
        }),
      );
      await within(strip).findByRole("button", {
        name: "Review request",
      });
      expect(
        await within(strip).findByText(/wants to run npm test -- board/),
      ).toBeTruthy();
      expect(strip.closest(".ticket-agent-slot")).toBe(slot);
      expect(
        await screen.findByRole("button", { name: "Chats, 1 waiting" }),
      ).toBeTruthy();
      // The host owns background gating and delivery; the strip must not send a second notification.
      expect(client.notify).toBe(true);
      expect(nativeNotifications).not.toHaveBeenCalled();
      // Inbox projects the same pending request before it is answered.
      fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
      expect(
        await screen.findByRole("button", {
          name: /Approval needed in.*Strip Chat/,
        }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /All tickets/ }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Focused Ticket/ }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Review request" }),
      );
      expect(
        await screen.findByRole("heading", { name: "Strip Chat" }),
      ).toBeTruthy();
      const answer = vi.spyOn(client, "answer");
      const allow = await screen.findByRole("button", { name: "Allow once" });
      allow.focus();
      fireEvent.keyDown(allow, { key: choice });
      await vi.waitFor(() =>
        expect(answer).toHaveBeenCalledWith("strip-chat", "approval", {
          option_id:
            choice === "1" ? "allow" : choice === "2" ? "session" : "deny",
        }),
      );
      expect(
        await screen.findByRole("button", { name: "Chats, 1 working" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
      await vi.waitFor(() =>
        expect(
          screen.queryByRole("button", {
            name: /Approval needed in.*Strip Chat/,
          }),
        ).toBeNull(),
      );
      fireEvent.click(screen.getByRole("button", { name: /All tickets/ }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Focused Ticket/ }),
      );
      const resumed = await screen.findByRole("status", {
        name: "Ticket agent",
      });
      expect(within(resumed).getByText(/is working on this/)).toBeTruthy();
      expect(
        within(resumed).queryByRole("button", { name: "Review request" }),
      ).toBeNull();
    } finally {
      focus.mockRestore();
      nativeNotifications.mockRestore();
    }
  },
);

test("ticket agent late start stays in the header until the next opening", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient, chatState } =
    await import("@/features/chats/mock-client");
  const tickets = paletteTickets();
  const client = createMockChatClient({
    enabled: true,
    chats: [{ chat: chatState({ id: "late", title: "Late Chat" }) }],
  });
  bridge.invoke.mockImplementation((command: string, args: unknown) =>
    command === "find_tickets"
      ? tickets
      : command === "show_ticket"
        ? tickets[1]
        : bridgeDefault(command, args as undefined),
  );
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Focused Ticket/ }),
  );
  await screen.findByRole("group", { name: "Ticket properties" });
  await vi.waitFor(() =>
    expect(
      document.querySelector(".detail-scroll[data-agent-loading]"),
    ).toBeNull(),
  );
  expect(screen.queryByRole("status", { name: "Ticket agent" })).toBeNull();
  act(() =>
    client.patch("late", {
      activity: "working",
      links: [
        {
          kind: "ticket",
          id: "2",
          reference: "T-KQ2",
          title: "Focused Ticket",
          status: "Todo",
        },
      ],
    }),
  );
  const header = screen
    .getByRole("heading", { name: "T-KQ2" })
    .closest(".detail-header")!;
  await vi.waitFor(() =>
    expect(within(header as HTMLElement).getByText("Working")).toBeTruthy(),
  );
  expect(screen.queryByRole("status", { name: "Ticket agent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Close ticket/ }));
  fireEvent.click(screen.getByRole("button", { name: /Focused Ticket/ }));
  expect(
    await screen.findByRole("status", { name: "Ticket agent" }),
  ).toBeTruthy();
});

test("ticket agent idle update preserves unseen Chat and opens its Activity", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient, chatState } =
    await import("@/features/chats/mock-client");
  const tickets = paletteTickets();
  const client = createMockChatClient({
    enabled: true,
    chats: [
      {
        chat: chatState({
          id: "idle-strip",
          title: "Finished Chat",
          unseen: true,
          links: [
            {
              kind: "ticket",
              id: "2",
              reference: "T-KQ2",
              title: "Focused Ticket",
              status: "Todo",
            },
          ],
        }),
      },
    ],
  });
  const open = vi.spyOn(client, "openChat");
  const update = {
    activity_id: "agent-update",
    editing_agent: "codex",
    brief: { text: "Kept the placeholder stable", truncated: false },
    reported_at: "2026-11-16T00:00:00Z",
    updated_at: "2026-11-16T00:00:00Z",
    supporting_document_id: null,
  };
  bridge.invoke.mockImplementation((command: string, args: unknown) =>
    command === "find_tickets"
      ? tickets
      : command === "show_ticket"
        ? tickets[1]
        : command === "latest_update"
          ? update
          : bridgeDefault(command, args as undefined),
  );
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Focused Ticket/ }),
  );
  const strip = await screen.findByRole("status", { name: "Ticket agent" });
  expect(within(strip).getByText(/Kept the placeholder stable/)).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  expect((await client.listChats("active"))[0]?.status.unseen).toBe(true);
  expect(strip.querySelector(".harness-mark")).toBeTruthy();
  fireEvent.click(within(strip).getByRole("button", { name: "Open Chat" }));
  expect(
    await screen.findByRole("heading", { name: "Finished Chat" }),
  ).toBeTruthy();
});

test.each([null, "codex"])(
  "ticket agent reserves an update slot only for agent attribution (%s)",
  async (editing_agent) => {
    const tickets = paletteTickets();
    bridge.invoke.mockImplementation((command: string, args: unknown) =>
      command === "find_tickets"
        ? tickets
        : command === "show_ticket"
          ? tickets[1]
          : command === "latest_update"
            ? {
                activity_id: "update",
                editing_agent,
                brief: {
                  text: "Kept the description steady",
                  truncated: false,
                },
                reported_at: "2026-11-16T00:00:00Z",
                updated_at: "2026-11-16T00:00:00Z",
                supporting_document_id: null,
              }
            : bridgeDefault(command, args as undefined),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Focused Ticket/ }),
    );
    await screen.findByRole("group", { name: "Ticket properties" });
    await vi.waitFor(() =>
      expect(
        document.querySelector(".detail-scroll[data-agent-loading]"),
      ).toBeNull(),
    );
    expect(
      Boolean(screen.queryByRole("status", { name: "Ticket agent" })),
    ).toBe(Boolean(editing_agent));
  },
);

test("palette orders Go to before Create and joins fuzzy Tickets, Documents and active Plans", async () => {
  const ticket = bulkTicket(1, { reference: "T-FV1", title: "Board geometry" });
  const doc = { id: "doc-board", heading: "Board handoff" };
  bridge.invoke.mockImplementation((command: string, args?: object) => {
    if (command === "find_tickets") return [ticket];
    if (command === "list_plans")
      return [
        { id: "plan-board", name: "Board polish", archived: false },
        { id: "plan-old", name: "Board retired", archived: true },
      ];
    if (command === "recent_documents") return [doc];
    if (command === "show_plan")
      return {
        plan: { id: "plan-board", name: "Board polish", archived: false },
        members: [],
        counts: {
          todo: 2,
          in_progress: 1,
          in_review: 0,
          done: 2,
          canceled: 5,
          duplicate: 1,
        },
      };
    if (command === "sidebar_counts")
      return { unread_inbox: 0, ready: 7, in_progress: 1 };
    if (command === "document_tags") return [];
    if (command === "open_document" || command === "show_document")
      return {
        id: doc.id,
        title: doc.heading,
        body: "A board handoff.",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        trashed: false,
      };
    return bridgeDefault(command, args);
  });
  render(<App />);
  await screen.findByRole("button", { name: /Board geometry/ });
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const input = await screen.findByRole("combobox", {
    name: "Search tickets and destinations",
  });
  const labels = screen
    .getAllByRole("option")
    .map((row) => row.getAttribute("data-value"));
  expect(labels.indexOf("inbox")).toBeLessThan(labels.indexOf("create-ticket"));
  expect(labels.filter((label) => label?.startsWith("create-"))).toEqual([
    "create-ticket",
    "create-capture",
    "create-chat",
    "create-plan",
  ]);
  expect(screen.getByRole("option", { name: /Ready/ }).textContent).toContain(
    "7 tickets",
  );
  fireEvent.change(input, { target: { value: "brd" } });
  expect(await screen.findByRole("option", { name: /T-FV1/ })).toBeTruthy();
  const documentResult = await screen.findByRole("option", {
    name: /Board handoff/,
  });
  expect(documentResult.querySelectorAll("mark").length).toBeGreaterThan(1);
  const plan = await screen.findByRole("option", { name: /Board polish/ });
  await vi.waitFor(() => expect(plan.textContent).toContain("2 of 5 done"));
  expect(screen.queryByRole("option", { name: /Board retired/ })).toBeNull();
  fireEvent.change(input, { target: { value: "T-FV" } });
  expect(await screen.findByRole("option", { name: /T-FV1/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Board handoff/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /New ticket/ })).toBeNull();
  fireEvent.change(input, { target: { value: "> brd" } });
  expect(
    screen.queryByRole("option", { name: /Board handoff|Board polish|T-FV1/ }),
  ).toBeNull();
  fireEvent.change(input, { target: { value: "brd hnd" } });
  fireEvent.click(await screen.findByRole("option", { name: /Board handoff/ }));
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("open_document", {
      id: "doc-board",
    }),
  );
  expect(screen.queryByRole("dialog", { name: "Go anywhere" })).toBeNull();
});

test("palette opens a named active Plan through the workspace navigation", async () => {
  bridge.invoke.mockImplementation((command: string, args?: object) =>
    command === "list_plans"
      ? [{ id: "plan-board", name: "Board polish", archived: false }]
      : bridgeDefault(command, args),
  );
  render(<App />);
  await screen.findByRole("button", { name: /Attachments/ });
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const input = await screen.findByRole("combobox", {
    name: "Search tickets and destinations",
  });
  fireEvent.change(input, { target: { value: "brd plsh" } });
  fireEvent.click(await screen.findByRole("option", { name: /Board polish/ }));
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("find_tickets", {
      filter: expect.objectContaining({ plan: "plan-board" }),
    }),
  );
  expect(screen.queryByRole("dialog", { name: "Go anywhere" })).toBeNull();
});

test("filter checks stay staged until the menu closes, then the bar follows the header", async () => {
  const tickets = [
    bulkTicket(1, { title: "First retained row", tags: ["polish"] }),
    bulkTicket(2, { title: "Second retained row", tags: [] }),
  ];
  bridge.invoke.mockImplementation(
    (
      command: string,
      args?: { filter?: { tags: string[] }; id?: string; reference?: string },
    ) => {
      if (command === "find_tickets")
        return args?.filter?.tags.length ? tickets.slice(0, 1) : tickets;
      if (command === "search_tags") return ["polish"];
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  const first = await screen.findByRole("button", {
    name: /First retained row/,
  });
  const second = await screen.findByRole("button", {
    name: /Second retained row/,
  });
  expect(screen.queryByLabelText("Active filters")).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "Filters" }), {
    key: "Enter",
  });
  fireEvent.keyDown(await screen.findByRole("menuitem", { name: /^Tags/ }), {
    key: "ArrowRight",
  });
  fireEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "polish" }),
  );
  expect(screen.queryByLabelText("Active filters")).toBeNull();
  expect(first.isConnected).toBe(true);
  expect(second.isConnected).toBe(true);
  expect(
    bridge.invoke.mock.calls
      .filter(([name]) => name === "find_tickets")
      .at(-1)?.[1],
  ).toEqual(
    expect.objectContaining({ filter: expect.objectContaining({ tags: [] }) }),
  );
  for (let step = 0; step < 3 && screen.queryAllByRole("menu").length; step++) {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await act(async () => {});
  }
  const bar = await screen.findByLabelText("Active filters");
  expect(bar.previousElementSibling?.getAttribute("data-slot")).toBe(
    "pane-header",
  );
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /Second retained row/ }),
    ).toBeNull(),
  );
  fireEvent.click(within(bar).getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("button", { name: /Second retained row/ });
  expect(screen.queryByLabelText("Active filters")).toBeNull();
});

test("Documents folds local search in its header and navigates one row stop without replacing the reader metadata", async () => {
  const docs = [
    {
      id: "guide",
      title: "Reader guide",
      body: "Keep this paragraph.",
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
      trashed: false,
    },
    {
      id: "spec",
      title: "Reader spec",
      body: "The next paragraph.",
      created_at: "2026-11-02T00:00:00Z",
      updated_at: "2026-11-02T00:00:00Z",
      trashed: false,
    },
  ];
  bridge.invoke.mockImplementation(
    (command: string, args: { id?: string; query?: string }) => {
      if (command === "recent_documents" || command === "all_documents")
        return docs.map((doc) => ({
          id: doc.id,
          heading: doc.title,
          updated_at: doc.updated_at,
        }));
      if (command === "search_documents")
        return docs
          .filter((doc) => doc.title.includes(args.query ?? ""))
          .map((doc) => ({
            id: doc.id,
            heading: doc.title,
            updated_at: doc.updated_at,
          }));
      if (command === "open_document" || command === "show_document")
        return docs.find((doc) => doc.id === args.id);
      if (command === "document_tags") return [];
      if (command === "document_version")
        return [docs.find((doc) => doc.id === args.id)?.updated_at, false];
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
  const first = await screen.findByRole("button", { name: "Reader guide" });
  const navigator = first.closest(".documents-list-view")!;
  const header = within(navigator as HTMLElement)
    .getByRole("heading", { name: "Documents" })
    .closest("header")!;
  expect(within(navigator as HTMLElement).queryByRole("searchbox")).toBeNull();
  fireEvent.click(
    within(header).getByRole("button", { name: "Search Documents" }),
  );
  const search = within(header).getByRole("searchbox", {
    name: "Search Documents",
  });
  fireEvent.change(search, { target: { value: "spec" } });
  expect(
    await screen.findByRole("button", { name: "Reader spec" }),
  ).toBeTruthy();
  fireEvent.keyDown(search, { key: "Escape" });
  expect(within(header).queryByRole("searchbox")).toBeNull();
  const rows = await within(navigator as HTMLElement).findAllByRole("button", {
    name: /^Reader (guide|spec)$/,
  });
  expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
  rows[0]!.focus();
  fireEvent.keyDown(rows[0]!, { key: "j" });
  expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: "Enter" });
  expect(
    await screen.findByRole("heading", { name: "Reader spec" }),
  ).toBeTruthy();
  expect(
    within(navigator as HTMLElement)
      .getByRole("heading", { name: "Documents" })
      .closest("header"),
  ).toBe(header);
  fireEvent.keyDown(rows[1]!, { key: "/" });
  expect(within(header).getByRole("searchbox")).toBeTruthy();
  fireEvent.keyDown(within(header).getByRole("searchbox"), {
    key: "k",
    ctrlKey: true,
  });
  const palette = await screen.findByRole("dialog");
  expect(within(palette).getByRole("combobox")).toBeTruthy();
  fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Escape" });
  fireEvent.keyDown(within(header).getByRole("searchbox"), { key: "Escape" });
  const metadata = screen.getByRole("status", {
    name: "Document sync status",
  }).parentElement;
  fireEvent.keyDown(document.body, { key: "e" });
  expect(
    await screen.findByRole("group", { name: "Edit controls" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("status", { name: "Document sync status" }).parentElement,
  ).toBe(metadata);
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  rows[1]!.focus();
  fireEvent.keyDown(rows[1]!, { key: "Escape" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Reader spec" })).toBeNull(),
  );
  expect(
    within(navigator as HTMLElement).getByRole("button", {
      name: "Reader spec",
    }),
  ).toBe(rows[1]);
});

test("Documents keeps pin grouping under keyboard focus, exposes exact times and restores a linked Plan Document", async () => {
  const timestamp = "2026-11-01T09:30:00Z";
  let pinned = false;
  let trashed = true;
  const stored = () => ({
    id: "linked-guide",
    title: "Linked guide",
    body: "A reusable guide.",
    created_at: timestamp,
    updated_at: timestamp,
    trashed,
  });
  const summary = {
    id: "linked-guide",
    heading: "Linked guide",
    updated_at: timestamp,
  };
  const other = {
    id: "other-guide",
    heading: "Other guide",
    updated_at: timestamp,
  };
  bridge.invoke.mockImplementation(
    (
      command: string,
      args: { id?: string; pinned?: boolean; trashed?: boolean },
    ) => {
      if (command === "list_plans")
        return [{ id: "guide-plan", name: "Guide launch", archived: false }];
      if (command === "recent_documents")
        return trashed ? [other] : [other, summary];
      if (command === "trashed_documents") return trashed ? [summary] : [];
      if (command === "pinned_documents") return pinned ? [summary] : [];
      if (command === "set_document_pin") {
        pinned = args.pinned ?? false;
        return null;
      }
      if (command === "set_document_trashed") {
        trashed = args.trashed ?? false;
        return stored();
      }
      if (command === "open_document" || command === "show_document")
        return stored();
      if (command === "document_version") return [timestamp, trashed];
      if (command === "document_tags") return [];
      if (command === "document_context_links" && args.id === summary.id)
        return [
          [],
          [
            {
              source_id: "guide-plan",
              target_id: summary.id,
              source_kind: "plan",
              target_kind: "document",
              passage: "",
              source_label: "Guide launch",
              target_label: summary.heading,
              source_trashed: false,
              target_trashed: trashed,
              explicit: true,
            },
          ],
        ];
      if (command === "show_plan")
        return {
          plan: {
            id: "guide-plan",
            name: "Guide launch",
            archived: false,
            spec_document_id: null,
          },
          counts: {
            todo: 0,
            in_progress: 0,
            in_review: 0,
            done: 0,
            canceled: 0,
          },
          members: [],
          documents: [{ ...summary, trashed: false }],
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
  fireEvent.click(screen.getByRole("radio", { name: "Trash" }));
  fireEvent.click(await screen.findByRole("button", { name: "Linked guide" }));
  expect(
    await screen.findByRole("heading", { name: "Linked guide" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit" })).toHaveProperty(
    "disabled",
    true,
  );
  const reader = screen
    .getByRole("heading", { name: "Linked guide" })
    .closest("article")!;
  const linked = within(reader).getByRole("complementary", {
    name: "Document details",
  });
  expect(within(linked).getByRole("heading", { name: "Linked" })).toBeTruthy();
  expect(
    await within(linked).findByRole("button", { name: "Guide launch" }),
  ).toBeTruthy();
  fireEvent.click(within(reader).getByRole("button", { name: "Restore" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Recent" }));
  const row = await screen.findByRole("button", { name: "Linked guide" });
  const navigator = row.closest(".documents-list-view") as HTMLElement;
  const order = () =>
    within(navigator)
      .getAllByRole("button", { name: /^(Other|Linked) guide$/ })
      .map((button) => button.textContent);
  expect(order()).toEqual(["Other guide", "Linked guide"]);
  row.focus();
  fireEvent.keyDown(row, { key: "p" });
  await vi.waitFor(() =>
    expect(
      within(navigator)
        .getByRole("button", { name: "Unpin Linked guide" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(order()).toEqual(["Other guide", "Linked guide"]);
  fireEvent.keyDown(row, { key: "ArrowRight" });
  expect(document.activeElement?.tagName).toBe("TIME");
  expect(await screen.findByRole("tooltip")).toHaveProperty(
    "textContent",
    new Date(timestamp).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.activeElement).toBe(row);
  act(() => screen.getByRole("button", { name: "Document actions" }).focus());
  await vi.waitFor(() =>
    expect(order()).toEqual(["Linked guide", "Other guide"]),
  );
  fireEvent.click(within(linked).getByRole("button", { name: "Guide launch" }));
  expect(
    await screen.findByRole("heading", { name: "Guide launch" }),
  ).toBeTruthy();
});

test("New Chat exposes its complete current pick before the first message", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient } = await import("@/features/chats/mock-client");
  const client = createMockChatClient({ enabled: true });
  bridge.invoke.mockImplementation(bridgeDefault);
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Chats" }));
  const trigger = await screen.findByRole("button", {
    name: "Claude Code, model Opus 5.5, effort Default",
  });
  expect(client.created).toHaveLength(0);
  fireEvent.click(trigger);
  const tab = await screen.findByRole("tab", { name: "Claude Code" });
  expect(
    within(tab).getByText("Claude Code").classList.contains("shrink-0"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /^Sonnet 5/ }));
  fireEvent.click(screen.getByRole("radio", { name: "High" }));
  expect(
    screen.getByRole("button", {
      name: "Claude Code, model Sonnet 5, effort High",
    }),
  ).toBeTruthy();
  expect(client.created).toHaveLength(0);
});

test("Attachments folds search in its header and shares the Documents navigator keys and return focus", async () => {
  const files = ["icon.png", "notes.txt"].map((name, index) => ({
    id: `library-${index}`,
    display_name: name,
    original_filename: name,
    size_bytes: index === 0 ? 567 : 17,
    kind: "local_snapshot",
    locator: `fixture/${name}`,
    added_at: "2026-11-14T10:46:00Z",
  }));
  bridge.invoke.mockImplementation(
    (
      command: string,
      args: { id?: string; query?: { search: string } } = {},
    ) => {
      if (command === "search_attachments")
        return files
          .filter((file) =>
            file.display_name.includes(args.query?.search ?? ""),
          )
          .map((attachment) => ({
            attachment,
            related: false,
            usage: {
              eligible: false,
              legacy_drafts_pending: false,
              protections: [
                {
                  kind: "ticket_attachment",
                  owner: "ticket",
                  ticket_id: "ticket",
                  trashed: false,
                },
              ],
            },
          }));
      if (command === "attachment_preview")
        return {
          attachment: files.find((file) => file.id === args.id),
          status: "unsupported",
          media_type: null,
          message: null,
          can_open: true,
          text_excerpt: { text: "Launch checklist", truncated: false },
          usage: { total: 1, legacy_drafts_pending: false, entries: [] },
        };
      if (command === "open_attachment") return null;
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
  await screen.findByRole("button", { name: "icon.png" });
  const header = screen
    .getByRole("heading", { name: "Attachments" })
    .closest("header")!;
  fireEvent.click(within(header).getByRole("button", { name: "Search files" }));
  const search = within(header).getByRole("searchbox", {
    name: "Search files",
  });
  fireEvent.change(search, { target: { value: "notes" } });
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "icon.png" })).toBeNull(),
  );
  fireEvent.keyDown(search, { key: "Escape" });
  expect(within(header).queryByRole("searchbox")).toBeNull();
  const restored = await screen.findByRole("button", { name: "icon.png" });
  restored.focus();
  fireEvent.keyDown(restored, { key: "j" });
  const second = screen.getByRole("button", { name: "notes.txt" });
  expect(document.activeElement).toBe(second);
  expect(screen.queryByRole("region", { name: "notes.txt" })).toBeNull();
  fireEvent.keyDown(second, { key: "Enter" });
  const preview = await screen.findByRole("region", { name: "notes.txt" });
  await within(preview).findByText("Launch checklist");
  fireEvent.click(within(preview).getByRole("button", { name: "Open file" }));
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("open_attachment", {
      id: "library-1",
    }),
  );
  fireEvent.click(
    within(preview).getByRole("button", { name: "Back to Attachments" }),
  );
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(second, { key: "Enter" });
  const reopened = await screen.findByRole("region", { name: "notes.txt" });
  fireEvent.keyDown(
    within(reopened).getByRole("heading", { name: "notes.txt" }),
    { key: "." },
  );
  expect(await screen.findByRole("menuitem", { name: "Rename…" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(screen.getByRole("region", { name: "notes.txt" })).toBe(reopened);
  fireEvent.keyDown(
    within(reopened).getByRole("heading", { name: "notes.txt" }),
    { key: "Escape" },
  );
  expect(document.activeElement).toBe(second);
  expect(
    screen.getByText(
      "Drop files anywhere on a ticket or Document to attach them. They are kept on this computer.",
    ),
  ).toBeTruthy();
});

test.each(["missing", "quarantined", "unavailable"])(
  "Attachments keeps %s recovery and Used in navigation in the preview",
  async (state) => {
    let restored = false;
    let retry = false;
    const file = () => ({
      id: "attachment-state",
      display_name: "notes.txt",
      original_filename: "notes.txt",
      size_bytes: 17,
      kind: "local_snapshot",
      locator: "fixture/notes.txt",
      quarantined: state === "quarantined" && !restored,
    });
    const owner = bulkTicket(1, { title: "Attachment owner" });
    bridge.invoke.mockImplementation(
      (command: string, args: { id?: string; reference?: string } = {}) => {
        if (command === "find_tickets") return [owner];
        if (command === "show_ticket") return owner;
        if (command === "search_attachments")
          return [
            {
              attachment: file(),
              related: false,
              missing: state === "missing",
              usage: {
                eligible: false,
                legacy_drafts_pending: false,
                protections: [],
              },
            },
          ];
        if (command === "attachment_preview")
          return {
            attachment: file(),
            status:
              state === "missing"
                ? "missing"
                : state === "unavailable" && !retry
                  ? "unavailable"
                  : "unsupported",
            media_type: null,
            message: null,
            can_open: state !== "missing",
            text_excerpt: retry
              ? { text: "Recovered preview", truncated: false }
              : null,
            usage: {
              total: 1,
              legacy_drafts_pending: false,
              entries: [
                {
                  kind: "ticket_attachment",
                  owner: "1",
                  label: "T-KQ1 · Attachment owner",
                  trashed: false,
                  target: { kind: "ticket", id: "T-KQ1" },
                },
              ],
            },
          };
        if (command === "restore_attachment") {
          restored = true;
          return file();
        }
        return bridgeDefault(command, args);
      },
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
    fireEvent.click(await screen.findByRole("button", { name: "notes.txt" }));
    const pane = await screen.findByRole("region", { name: "notes.txt" });
    const stage = pane.querySelector(".attachment-preview-stage");
    if (state === "missing") {
      await within(pane).findByText("This file is missing from this computer");
      expect(
        within(pane).getByRole("button", { name: "Open file" }),
      ).toHaveProperty("disabled", true);
      expect(
        within(pane).getByRole("button", { name: "Restore from a backup…" }),
      ).toBeTruthy();
    } else if (state === "quarantined") {
      fireEvent.click(
        await within(pane).findByRole("button", { name: "Restore file" }),
      );
      await vi.waitFor(() =>
        expect(
          within(pane).queryByRole("button", { name: "Restore file" }),
        ).toBeNull(),
      );
      expect(bridge.invoke).toHaveBeenCalledWith(
        "restore_attachment",
        expect.objectContaining({ id: "attachment-state" }),
      );
    } else {
      await within(pane).findByText("Couldn't read this file");
      retry = true;
      fireEvent.click(within(pane).getByRole("button", { name: "Retry" }));
      await within(pane).findByText("Recovered preview");
    }
    expect(pane.querySelector(".attachment-preview-stage")).toBe(stage);
    fireEvent.click(
      await within(pane).findByRole("button", {
        name: "T-KQ1 · Attachment owner",
      }),
    );
    expect(
      await screen.findByRole("textbox", { name: "Title" }),
    ).toHaveProperty("value", "Attachment owner");
  },
);

test("a blocker removed and re-added through Linked is visible and can be removed with Undo", async () => {
  const current = bulkTicket(1, { title: "Waiting outcome" });
  const blocker = bulkTicket(2, { title: "Required outcome" });
  let linked = true;
  bridge.invoke.mockImplementation(
    (
      command: string,
      args?: { reference?: string; prerequisite?: string; dependent?: string },
    ) => {
      if (command === "find_tickets") return [current];
      if (command === "show_ticket")
        return args?.reference === blocker.reference ? blocker : current;
      if (command === "search_tickets") return [blocker];
      if (command === "add_dependency" || command === "remove_dependency") {
        linked = command === "add_dependency";
        return current;
      }
      if (command === "contextual_relationships") {
        const result = bridgeDefault(command) as {
          relationships: {
            prerequisites: { items: unknown[]; next_offset: null };
          };
        };
        result.relationships.prerequisites = {
          next_offset: null,
          items: linked
            ? [
                {
                  reference: blocker.reference,
                  title: { text: blocker.title },
                  status: "Todo",
                  trashed: false,
                  unresolved: true,
                },
              ]
            : [],
        };
        return result;
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Waiting outcome/ }),
  );
  const removeLabel = `Remove ${blocker.reference} from Blocked by`;
  const remove = await screen.findByRole("button", { name: removeLabel });
  vi.useFakeTimers();
  fireEvent.click(remove);
  await act(async () => vi.advanceTimersByTimeAsync(401));
  vi.useRealTimers();
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: removeLabel })).toBeNull(),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Link a ticket" }));
  const dialog = await screen.findByRole("dialog", { name: "Link a ticket" });
  fireEvent.click(
    within(dialog).getByRole("combobox", { name: /Relationship/ }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "is blocked by" }));
  fireEvent.change(
    within(dialog).getByRole("combobox", {
      name: "Ticket",
    }),
    { target: { value: blocker.reference } },
  );
  fireEvent.click(
    await screen.findByRole("option", { name: /Required outcome/ }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Link ticket" }));
  expect(await screen.findByRole("button", { name: removeLabel })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: removeLabel }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await screen.findByRole("button", { name: removeLabel })).toBeTruthy();
});

test("empty Ticket evidence adds, removes, and restores through Undo", async () => {
  const current = bulkTicket(1, { title: "Evidence outcome" });
  let items: import("@/lib/api/client").Evidence[] = [];
  const writes = new Map<string, import("@/lib/api/client").Evidence>();
  let replyLost = false;
  bridge.invoke.mockImplementation(
    (
      command: string,
      args?: {
        input?: import("@/lib/api/client").EvidenceInput;
        requestId?: string;
      },
    ) => {
      if (command === "find_tickets") return [current];
      if (command === "show_ticket") return current;
      if (command === "list_evidence") return items;
      if (command === "add_evidence") {
        const key = args?.requestId ?? "";
        const known = writes.get(key);
        if (known) return known;
        const item: import("@/lib/api/client").Evidence = {
          id: crypto.randomUUID(),
          kind: "pull_request",
          name: "Review",
          value: "example/app#42",
          editing_agent: null,
          created_at: "2026-11-16T00:00:00Z",
          updated_at: "2026-11-16T00:00:00Z",
          ...args?.input,
        };
        writes.set(key, item);
        items = [...items, item];
        if (writes.size === 2 && !replyLost) {
          replyLost = true;
          throw {
            code: "failed",
            message: "The restoration reply was lost. Try again.",
          };
        }
        return item;
      }
      if (command === "delete_evidence") {
        items = [];
        return;
      }
      return bridgeDefault(command);
    },
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Evidence outcome/ }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Evidence" }));
  const dialog = await screen.findByRole("dialog", { name: "Add evidence" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Review" },
  });
  fireEvent.change(within(dialog).getByLabelText("URL, reference, or path"), {
    target: { value: "example/app#42" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add evidence" }));
  const actions = await screen.findByRole("button", {
    name: "Actions for Review",
  });
  fireEvent.keyDown(actions, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete evidence" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Actions for Review" });
  expect(
    screen.getAllByRole("button", { name: "Actions for Review" }),
  ).toHaveLength(1);
});

test("empty Ticket Files adds an existing file and detaches with Undo", async () => {
  const current = bulkTicket(1, { title: "File outcome" });
  const file = {
    id: "file-one",
    display_name: "review.txt",
    original_filename: "review.txt",
    size_bytes: 12,
    kind: "local_snapshot",
    locator: "review.txt",
  };
  let attached = false;
  bridge.invoke.mockImplementation(
    (command: string, args?: { present?: boolean }) => {
      if (command === "find_tickets") return [current];
      if (command === "show_ticket") return current;
      if (command === "ticket_attachments") return attached ? [file] : [];
      if (command === "search_attachments")
        return [
          {
            attachment: file,
            related: false,
            usage: {
              eligible: true,
              legacy_drafts_pending: false,
              protections: [],
            },
          },
        ];
      if (command === "inspect_attachment") return file;
      if (command === "set_ticket_attachment") {
        attached = Boolean(args?.present);
        return;
      }
      if (command === "attachment_preview")
        return {
          attachment: file,
          status: "unsupported",
          media_type: null,
          message: null,
          can_open: true,
          usage: {
            total: attached ? 1 : 0,
            legacy_drafts_pending: false,
            entries: [],
          },
        };
      return bridgeDefault(command);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /File outcome/ }));
  fireEvent.keyDown(await screen.findByRole("button", { name: "File" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "File…" }));
  fireEvent.click(await screen.findByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select review.txt" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  fireEvent.click(await screen.findByRole("button", { name: "review.txt" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Detach from ticket" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(
    await screen.findByRole("button", { name: "review.txt" }),
  ).toBeTruthy();
});

test("Linked shows a blocking subticket once and the scrolled title reuses its header", async () => {
  const current = bulkTicket(1, { title: "A long outcome to keep in view" });
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets") return [current];
    if (command === "show_ticket") return current;
    if (command === "contextual_relationships") {
      const item = {
        reference: "T-KQ2",
        title: { text: "The shared prerequisite" },
        status: "Todo",
        trashed: false,
        unresolved: true,
      };
      return {
        relationships: {
          parent: null,
          children: { items: [item], next_offset: null },
          children_progress: { total: 1, done: 0 },
          prerequisites: { items: [item], next_offset: null },
          blocking: { items: [], next_offset: null },
          related: { items: [], next_offset: null },
          discovered_while: { items: [], next_offset: null },
          discoveries: { items: [], next_offset: null },
          duplicate_of: null,
          duplicates: { items: [], next_offset: null },
        },
      };
    }
    return bridgeDefault(command);
  });
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /A long outcome/ }),
  );
  expect(await screen.findByRole("heading", { name: "Linked 1" })).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "The shared prerequisite" }),
  ).toHaveLength(1);
  expect(screen.getByText("Todo · blocks this")).toBeTruthy();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Actions for linked T-KQ2" }),
    { key: "Enter" },
  );
  expect(
    await screen.findByRole("menuitem", { name: "Remove subticket" }),
  ).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Remove blocker" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Remove blocker" }), {
    key: "Escape",
  });
  const reference = screen.getByRole("heading", { name: current.reference });
  const header = reference.closest("header");
  if (!header) throw new Error("Ticket header is missing");
  const scroller = document.querySelector(".detail-scroll");
  if (!scroller) throw new Error("Ticket scroller is missing");
  const title = document.querySelector<HTMLElement>(
    ".detail-content:not([hidden]) .editor-title",
  );
  if (!title) throw new Error("Ticket title is missing");
  const box = title.getBoundingClientRect();
  vi.spyOn(title, "getBoundingClientRect").mockImplementation(() => ({
    ...box,
    bottom: 100 - scroller.scrollTop,
  }));
  fireEvent.scroll(scroller, { target: { scrollTop: 300 } });
  expect(
    within(header).getByText(/A long outcome to keep in view/).textContent,
  ).toBe(`· ${current.title}`);
  expect(reference.closest("header")).toBe(header);
  fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
  expect(
    within(header).queryByText(/A long outcome to keep in view/),
  ).toBeNull();
});

test("an empty Ticket folds Activity and R opens its existing composer without losing its draft", async () => {
  const current = bulkTicket(99, { title: "Quiet outcome" });
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets") return [current];
    if (command === "show_ticket") return current;
    return bridgeDefault(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Quiet outcome/ }));
  await screen.findByRole("button", { name: "File" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull(),
  );
  expect(
    screen.getAllByRole("group", { name: "Add to this ticket" }),
  ).toHaveLength(1);
  fireEvent.keyDown(document.body, { key: "r" });
  expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  const brief = screen.getByRole("textbox", { name: "New update source" });
  fireEvent.change(brief, { target: { value: "A retained update draft" } });
  fireEvent.keyDown(brief, { key: "Escape" });
  expect(
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", "A retained update draft");
});

test("first run creates through the shared dialog and gives way to the ticket list", async () => {
  let created = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "find_tickets") return created ? [bulkTicket(1)] : [];
      if (command === "create_ticket") {
        created = true;
        return bulkTicket(1);
      }
      if (command === "show_ticket") return bulkTicket(1);
      if (command === "workspace_info")
        return {
          ...((await bridgeDefault(command)) as object),
          tickets: created ? 1 : 0,
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  const guide = await screen.findByRole("region", {
    name: "Your workspace is ready",
  });
  fireEvent.click(within(guide).getByRole("button", { name: /New ticket/ }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
    target: { value: "First" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await screen.findByRole("button", { name: /First/ });
  expect(
    screen.queryByRole("region", { name: "Your workspace is ready" }),
  ).toBeNull();
});

test("first-run Install skill settles successful reads and keeps Settings navigation responsive", async () => {
  let reads = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      // Stop a regressed effect loop at the bridge boundary, rather than hanging
      // the runner. Every answer before the cap is a valid successful read.
      if (command === "agent_skills") {
        if (++reads > 8) throw new Error("Agent skill checks did not settle");
        return [];
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  const guide = await screen.findByRole("region", {
    name: "Your workspace is ready",
  });
  fireEvent.click(within(guide).getByRole("button", { name: "Install skill" }));
  await act(async () => {});
  expect(reads).toBeLessThanOrEqual(6);
  expect(
    screen.getByText("No supported agent was found on this computer"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  expect(
    screen.getByRole("heading", { level: 1, name: "Appearance" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Back to tickets/ }));
  expect(
    await screen.findByRole("region", { name: "Your workspace is ready" }),
  ).toBeTruthy();
});

test("Settings Agent skills settles reads and refreshes its setup dot after install and Check again", async () => {
  let reads = 0;
  let installed = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "agent_skills") {
        if (++reads > 12) throw new Error("Agent skill checks did not settle");
        return [
          {
            id: "claude",
            name: "Claude Code",
            path: "/fake/skills",
            detected: true,
            state: installed ? "installed" : "not_installed",
            error: null,
          },
        ];
      }
      if (command === "install_agent_skill") {
        installed = true;
        return { backup: null };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const nav = within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  );
  fireEvent.click(nav.getByRole("button", { name: /^Agent skills/ }));
  await act(async () => {});
  expect(reads).toBeLessThanOrEqual(6);
  const skillNav = () =>
    within(nav.getByRole("button", { name: /^Agent skills/ }));
  expect(skillNav().getByRole("img", { name: "Needs setup" })).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", { name: "Install for Claude Code" }),
  );
  await act(async () => {});
  expect(screen.getByText("Done for Claude Code.")).toBeTruthy();
  expect(skillNav().queryByRole("img", { name: "Needs setup" })).toBeNull();
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "install_agent_skill",
    ),
  ).toEqual([["install_agent_skill", { agent: "claude", replace: false }]]);

  installed = false;
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Install for Claude Code" }),
  ).toBeTruthy();
  expect(skillNav().getByRole("img", { name: "Needs setup" })).toBeTruthy();
  expect(reads).toBeLessThanOrEqual(10);
  fireEvent.click(nav.getByRole("button", { name: "Appearance" }));
  expect(
    screen.getByRole("heading", { level: 1, name: "Appearance" }),
  ).toBeTruthy();
});

test("Settings Command line settles successful checks and Check again updates the setup dot", async () => {
  let reads = 0;
  let installed = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "check_cli") {
        if (++reads > 12) throw new Error("Command-line checks did not settle");
        return installed
          ? {
              found: true,
              on_path: true,
              path: "/fake/bin/ticketd",
              version: "0.1.0",
              version_matches: true,
              workspace_path: "/fake/workspace.sqlite3",
              workspace_matches: true,
              app_version: "0.1.0",
              app_workspace_path: "/fake/workspace.sqlite3",
              suggested_directory: "~/.local/bin",
            }
          : bridgeDefault(command, args);
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const nav = within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  );
  fireEvent.click(nav.getByRole("button", { name: /^Command line/ }));
  await act(async () => {});
  expect(reads).toBeLessThanOrEqual(5);
  expect(screen.getByText("Not found")).toBeTruthy();
  const cliNav = () =>
    within(nav.getByRole("button", { name: /^Command line/ }));
  expect(cliNav().getByRole("img", { name: "Needs setup" })).toBeTruthy();

  installed = true;
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await act(async () => {});
  expect(
    screen.getByText("It matches this app and uses this workspace."),
  ).toBeTruthy();
  expect(cliNav().queryByRole("img", { name: "Needs setup" })).toBeNull();
  installed = false;
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await act(async () => {});
  expect(screen.getByText("Not found")).toBeTruthy();
  expect(cliNav().getByRole("img", { name: "Needs setup" })).toBeTruthy();
  expect(reads).toBeLessThanOrEqual(9);
  fireEvent.click(nav.getByRole("button", { name: "Appearance" }));
  expect(
    screen.getByRole("heading", { level: 1, name: "Appearance" }),
  ).toBeTruthy();
});

test("first run reads completed steps and opens the exact existing Settings sections", async () => {
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "agent_skills")
        return [
          {
            id: "claude",
            name: "Claude Code",
            path: "/fake/skills",
            detected: true,
            state: "installed",
            error: null,
          },
        ];
      if (command === "sync_status")
        return syncStatus({ connection: "connected" });
      if (command === "sync_settings") return syncSettings();
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  const guide = await screen.findByRole("region", {
    name: "Your workspace is ready",
  });
  expect(await within(guide).findByText(/Let your agents in/)).toBeTruthy();
  await act(async () => {});
  expect(
    within(guide)
      .getByText(/Let your agents in/)
      .closest('[data-slot="step"]')
      ?.getAttribute("data-state"),
  ).toBe("done");
  expect(
    within(guide)
      .getByText(/Keep it on every Mac/)
      .closest('[data-slot="step"]')
      ?.getAttribute("data-state"),
  ).toBe("done");
  fireEvent.click(within(guide).getByRole("button", { name: "Install skill" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Agent skills" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Back to tickets/ }));
  fireEvent.click(
    within(
      await screen.findByRole("region", { name: "Your workspace is ready" }),
    ).getByRole("button", { name: "Set up" }),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Google Drive" }),
  ).toBeTruthy();
  expect(
    bridge.invoke.mock.calls.some(([command]) =>
      ["install_agent_skill", "sync_connect", "sync_setup"].includes(command),
    ),
  ).toBe(false);
});

test.each(["ready", "trashed"] as const)(
  "first run stays absent when existing tickets are %s",
  async (kind) => {
    bridge.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "workspace_info")
          return {
            ...((await bridgeDefault(command)) as object),
            tickets: kind === "ready" ? 1 : 0,
          };
        if (command === "list_trash")
          return [{ ...bulkTicket(1), trashed: true }];
        if (command === "find_tickets") return [];
        return bridgeDefault(command, args);
      },
    );
    render(<App />);
    await act(async () => {});
    expect(await screen.findByText("No tickets yet")).toBeTruthy();
    if (kind === "ready")
      fireEvent.click(screen.getByRole("button", { name: /^Ready/ }));
    else fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    expect(
      await screen.findByText(
        kind === "ready" ? "No Ready tickets" : "Trash is empty",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Your workspace is ready" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Install skill" })).toBeNull();
  },
);
test("header Follow keeps failures in the pane status line, retries and respects read-only state", async () => {
  const current = bulkTicket(1, { title: "Follow outcome" });
  let following = false;
  let failed = true;
  bridge.invoke.mockImplementation(
    (command: string, args?: { following?: boolean }) => {
      if (command === "find_tickets") return [current];
      if (command === "show_ticket") return current;
      if (command === "is_following") return following;
      if (command === "set_following") {
        if (failed) throw new Error("Storage is busy");
        following = args?.following ?? false;
        return null;
      }
      return bridgeDefault(command);
    },
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Follow outcome/ }),
  );
  const follow = await screen.findByRole("button", { name: "Follow" });
  const header = follow.closest("header");
  expect(header).toBeTruthy();
  expect(
    within(
      screen.getByRole("group", { name: "Ticket properties" }),
    ).queryByRole("button", { name: "Follow" }),
  ).toBeNull();
  fireEvent.click(follow);
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(follow.closest("header")).toBe(header);
  expect(header?.querySelector('[role="alert"]')).toBeNull();
  expect(follow.getAttribute("aria-pressed")).toBe("false");
  failed = false;
  fireEvent.click(retry);
  await vi.waitFor(() =>
    expect(follow.getAttribute("aria-pressed")).toBe("true"),
  );
  following = false;
  await vi.waitFor(
    () => expect(follow.getAttribute("aria-pressed")).toBe("false"),
    { timeout: 3000 },
  );
  act(() => reportWorkspaceFailure("workspace_read_only", "Read only"));
  expect(follow.hasAttribute("disabled")).toBe(true);
});

test.each([
  ["Agent skills", "Agent skills"],
  ["Google Drive sync", "Google Drive"],
])(
  "first run's %s action is also reachable in the palette",
  async (command, heading) => {
    bridge.invoke.mockImplementation(bridgeDefault);
    render(<App />);
    await screen.findByRole("region", { name: "Your workspace is ready" });
    fireEvent.click(screen.getByRole("button", { name: "Search or jump to…" }));
    const palette = await screen.findByRole("dialog", {
      name: "Go anywhere",
    });
    fireEvent.click(
      within(palette).getByRole("option", { name: new RegExp(command) }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: heading }),
    ).toBeTruthy();
  },
);
