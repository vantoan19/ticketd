import { DraftRecoveryProvider } from "@/lib/draft-recovery";
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
  waitFor,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";
import { launch } from "@/components/layout/launch";
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
const viewportListeners = new Set<() => void>();
function resizeViewport(narrow: boolean) {
  narrowViewport = narrow;
  viewportListeners.forEach((listener) => listener());
}
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: narrowViewport,
    addEventListener(_event: string, listener: () => void) {
      viewportListeners.add(listener);
    },
    removeEventListener(_event: string, listener: () => void) {
      viewportListeners.delete(listener);
    },
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
      if (args && typeof args === "object" && "projection" in args) {
        const projection = args as { projection: string; ids?: string[] };
        const metadata = (tickets as Ticket[]).filter(
          (ticket) => !projection.ids || projection.ids.includes(ticket.id),
        );
        return {
          items: metadata.map((ticket) => ({
            ...ticket,
            ...(projection.projection === "flow" && {
              prerequisites: ticket.prerequisites.slice(0, 50),
            }),
          })),
          omitted:
            projection.projection === "flow" &&
            metadata.some((ticket) => ticket.prerequisites.length > 50),
        };
      }
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
// The launch cascade is the shell's (components/layout/arrive); what App owes
// it is when it runs, so a test can watch the calls.
vi.mock("@/components/layout/launch", () => ({ launch: vi.fn() }));

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
  sessionStorage.clear();
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

/** Collapse the sidebar and let the groups finish folding into their icons. */
async function foldSidebar() {
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
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

test("the project names are sidebar labels, so the rail's fade and the unfold's hold reach them", async () => {
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
  const names = within(
    screen.getByRole("navigation", { name: "Project scopes" }),
  ).getAllByRole("button");
  for (const row of names)
    expect(row.querySelector(".sidebar-label")?.textContent).toBe(
      row.textContent?.trim(),
    );
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

test('the first-run guide stays until the list holds the first ticket, so "No tickets yet" never shows in between', async () => {
  // The workspace counts the ticket (and the new ticket opens) before the list
  // has read it; the test holds the list's answer back.
  let created = false;
  let listed = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "find_tickets") return listed ? [bulkTicket(1)] : [];
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
  // The list stays mounted behind \`hidden\` while the guide is up.
  const emptyShown = () => {
    const empty = screen.queryByText("No tickets yet");
    return empty !== null && empty.closest("[hidden]") === null;
  };
  fireEvent.click(within(guide).getByRole("button", { name: /New ticket/ }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
    target: { value: "First" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await vi.waitFor(() => expect(created).toBe(true));
  // Let the workspace's own reads catch up while the list has not.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(
    screen.queryByRole("region", { name: "Your workspace is ready" }),
  ).not.toBeNull();
  expect(emptyShown()).toBe(false);
  // The list holds the ticket: the guide goes, the row is there.
  listed = true;
  fireEvent.focus(window);
  await screen.findByRole("button", { name: /First/ }, { timeout: 5000 });
  expect(
    screen.queryByRole("region", { name: "Your workspace is ready" }),
  ).toBeNull();
  expect(emptyShown()).toBe(false);
});

test('a new Workspace shows neither placeholders nor "No tickets yet" while it is still unknown, only the guide', async () => {
  // The list's own read finishes (nothing in it) before the Workspace says how
  // many tickets it has; in between the list must show nothing of its own.
  let release = () => {};
  const infoRead = new Promise<void>((resolve) => (release = resolve));
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "workspace_info") await infoRead;
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  const onShow = (text: string | RegExp) => {
    const found = screen.queryAllByText(text);
    return found.some((node) => node.closest("[hidden]") === null);
  };
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(onShow("No tickets yet")).toBe(false);
  expect(onShow("Loading tickets…")).toBe(false);
  expect(
    screen.queryByRole("region", { name: "Your workspace is ready" }),
  ).toBeNull();
  release();
  await screen.findByRole("region", { name: "Your workspace is ready" });
  expect(onShow("No tickets yet")).toBe(false);
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
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn't confirm the new ticket",
  );
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
  expect(screen.getByRole("button", { name: /Second/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("heading", { name: "All tickets" }));
  expect(screen.queryByRole("button", { name: /Second/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close ticket details" }));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "All tickets" }),
  );
});

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
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
  openMenu("More selected ticket actions");
  fireEvent.click(screen.getByRole("menuitem", { name: "Select all 2" }));
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
      if (fail) throw { code: "unavailable", message: "RAW-DIAGNOSTIC-0xdead" };
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
  expect(alert).toContain("The selection is kept");
  expect(alert).not.toContain("RAW-DIAGNOSTIC-0xdead");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("RAW-DIAGNOSTIC-0xdead")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
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
  expect(alert.contains(document.activeElement)).toBe(true);
  expect(alert.textContent).toContain("T-KQ2");
  expect(alert.textContent).not.toContain("is trashed");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("invalid batch: T-KQ2 is trashed")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(alert.textContent).toContain("Nothing changed.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.getByText("2 selected")).toBeTruthy();
});

test("moves selected tickets to a project from the direct Project control", async () => {
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
  openMenu("Project of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Project one" }));
  await act(async () => {});
  expect(changes).toEqual([{ project_id: "p1" }]);
});

test("a bulk change reloads the list once: its write report already moves the shared version", async () => {
  let lists = 0;
  await renderBulk({
    find_tickets: () => {
      lists += 1;
      return [bulkTicket(1)];
    },
    list_projects: () => [
      { id: "p1", name: "Project one", path: "/p", paths: ["/p"] },
    ],
    bulk_change: () => [],
  });
  const before = lists;
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  openMenu("Project of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Project one" }));
  for (let turn = 0; turn < 5; turn += 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  expect(lists - before).toBe(1);
});

// Like renderBulk, but a command with no handler gets the shared default.
async function renderReplaceable(handlers: Record<string, unknown>) {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string, args?: never) => {
    if (!(command in handlers)) return bridgeDefault(command, args);
    const handler = handlers[command];
    return typeof handler === "function" ? handler(args) : handler;
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const driveOptions = {
  local: { tickets: 2, documents: 0, attachments: 0 },
  existing: [
    {
      folder_id: "folder-1",
      folder_name: "ticketd · other",
      last_synced_by: "Studio",
      last_synced_at: "2026-11-01T00:00:00Z",
      counts: { tickets: 2, documents: 0, attachments: 0 },
    },
  ],
  reconnect: null,
};

test("a Drive download that replaces the Workspace drops the old selection and a failed bulk change", async () => {
  const sent: string[] = [];
  let downloaded = false;
  await renderReplaceable({
    find_tickets: () => [bulkTicket(1), bulkTicket(2)],
    sync_status: syncStatus({
      connection: "choosing",
      folder: null,
      state: "saved_locally",
      last_synced_at: null,
    }),
    sync_settings: syncSettings(),
    sync_setup_options: driveOptions,
    sync_download_workspace: () => {
      downloaded = true;
      return { ...syncStatus(), safety_backup: "/ticketd/safety.sqlite3" };
    },
    bulk_status: (args: { requestId: string }) => {
      sent.push(args.requestId);
      throw { code: "unavailable", message: "lost reply" };
    },
  });
  const turn = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ2" }));
  openMenu("Status of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
  await turn();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await turn();
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("button", { name: "Google Drive" }),
  );
  for (let i = 0; i < 3; i += 1) await turn();
  fireEvent.click(
    screen.getByRole("radio", { name: /Download “ticketd · other”/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download…" }));
  await turn();
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "Replace this Workspace?" }),
    ).getByRole("button", { name: "Replace Workspace" }),
  );
  for (let i = 0; i < 4; i += 1) await turn();
  expect(downloaded).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Back to tickets/ }));
  for (let i = 0; i < 2; i += 1) await turn();

  // The old selection and the batch it sent belong to the replaced Workspace.
  expect(screen.queryByText("2 selected")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(sent).toHaveLength(1);
});

test("a restore reads the list once, during the restore", async () => {
  const backup = "/tmp/restore-once.ticketd-backup";
  const summary = {
    last_change: null,
    tickets: 1,
    documents: 0,
    activities: 0,
    evidence: 0,
    projects: 0,
    plans: 0,
  };
  let lists = 0;
  await renderReplaceable({
    find_tickets: () => {
      lists += 1;
      return [bulkTicket(1)];
    },
    safety_backups: [
      {
        path: backup,
        kind: "safety",
        saved_at: "2026-11-01T00:00:00Z",
        size_bytes: 1024,
      },
    ],
    inspect_backup: {
      path: backup,
      current: summary,
      check: { status: "valid", format_version: 19, summary },
    },
    restore_workspace: { safety_path: "/tmp/safety.sqlite3" },
    draft_retentions: [],
    draft_cutover_pending: false,
  });
  const turn = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await turn();
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("button", { name: "Backups" }),
  );
  for (let i = 0; i < 3; i += 1) await turn();
  fireEvent.click(screen.getByRole("button", { name: `Restore… ${backup}` }));
  for (let i = 0; i < 3; i += 1) await turn();
  const before = lists;
  fireEvent.click(screen.getByRole("button", { name: "Replace workspace" }));
  for (let i = 0; i < 6; i += 1) await turn();
  expect(screen.getByText("Workspace restored")).toBeTruthy();
  expect(lists - before).toBe(1);
});

test("a restore plays the launch cascade once, after the new Workspace's change token is read and the old reads are dropped", async () => {
  const backup = "/tmp/restore-launch.ticketd-backup";
  const summary = {
    last_change: null,
    tickets: 1,
    documents: 0,
    activities: 0,
    evidence: 0,
    projects: 0,
    plans: 0,
  };
  const order: string[] = [];
  vi.mocked(launch).mockReset();
  vi.mocked(launch).mockImplementation(() => void order.push("launch"));
  const nextToken = bridge.token.next;
  bridge.token.next = () => {
    order.push("token");
    return nextToken();
  };
  await renderReplaceable({
    find_tickets: () => [bulkTicket(1)],
    safety_backups: [
      {
        path: backup,
        kind: "safety",
        saved_at: "2026-11-01T00:00:00Z",
        size_bytes: 1024,
      },
    ],
    inspect_backup: {
      path: backup,
      current: summary,
      check: { status: "valid", format_version: 19, summary },
    },
    restore_workspace: { safety_path: "/tmp/safety.sqlite3" },
    draft_retentions: [],
    draft_cutover_pending: false,
  });
  const turn = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  // The window opening played it once.
  expect(order.filter((step) => step === "launch")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await turn();
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("button", { name: "Backups" }),
  );
  for (let i = 0; i < 3; i += 1) await turn();
  fireEvent.click(screen.getByRole("button", { name: `Restore… ${backup}` }));
  for (let i = 0; i < 3; i += 1) await turn();
  const before = order.length;
  fireEvent.click(screen.getByRole("button", { name: "Replace workspace" }));
  for (let i = 0; i < 6; i += 1) await turn();
  for (let i = 0; i < 6; i += 1) await turn();
  bridge.token.next = nextToken;
  expect(screen.getByText("Workspace restored")).toBeTruthy();
  // One launch, after the new Workspace's token was read (the first step of
  // dropping the old reads), never before it.
  const after = order.slice(before);
  expect(after.filter((step) => step === "launch")).toHaveLength(1);
  expect(after.indexOf("token")).toBeGreaterThanOrEqual(0);
  expect(after.indexOf("launch")).toBeGreaterThan(after.lastIndexOf("token"));
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
  openMenu("More selected ticket actions");
  fireEvent.click(screen.getByRole("menuitem", { name: "Select all 3" }));
  openMenu("Plan of selected tickets");
  expect(screen.getByRole("menuitem", { name: "Launch 1 of 3" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Polish 0 of 3" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Old/ })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Polish 0 of 3" }));
  await act(async () => {});
  expect(changes).toEqual([{ plan_id: "e2" }]);
});

test("removes a Plan and removes a tag from the direct controls", async () => {
  const changes: unknown[] = [];
  await renderBulk({
    find_tickets: () => [bulkTicket(1, { plan_id: "e1", tags: ["old"] })],
    bulk_change: (args: { change: unknown }) => {
      changes.push(args.change);
      return [];
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  openMenu("Plan of selected tickets");
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Plan" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  openMenu("Tags of selected tickets");
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

test("Tags has a separate Add tag action", async () => {
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
  openMenu("Tags of selected tickets");
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
      selector: '.ui-pane-header [data-slot="count"] span',
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
    within(dialog).getByRole("button", { name: "Status: In review" }),
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
  openMenu("More selected ticket actions");
  fireEvent.click(screen.getByRole("menuitem", { name: "Select all 50" }));
  openMenu("More selected ticket actions");
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Select all 51 matching" }),
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

test("Board Retry restores its header total and each well through one shared refresh", async () => {
  const tickets = [
    bulkTicket(1),
    bulkTicket(2),
    bulkTicket(3, { status: "In progress" }),
  ];
  let fail = true;
  act(() => setPreference("ticketLayout", "board"));
  await renderBulk({
    find_tickets: ({ filter }: { filter: { status: string | null } }) => {
      if (fail) throw new Error("Initial Board read unavailable");
      return tickets.filter(
        (ticket) => !filter.status || ticket.status === filter.status,
      );
    },
    count_tickets: ({ filter }: { filter: { status: string | null } }) => {
      if (fail) throw new Error("Initial counts unavailable");
      return filter.status === "Todo"
        ? counted({ todo: 2 })
        : filter.status === "In progress"
          ? counted({ in_progress: 1 })
          : filter.status
            ? counted({})
            : counted({ todo: 2, in_progress: 1 });
    },
  });
  const header = screen
    .getByRole("heading", { name: "All tickets" })
    .closest("header")!;
  expect(within(header).queryByText("3", { exact: true })).toBeNull();
  const retry = screen.getAllByRole("button", { name: "Retry" })[0]!;
  fail = false;
  bridge.invoke.mockClear();
  fireEvent.click(retry);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(within(header).getByText("3", { exact: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: /T-KQ1.*First/ })).toBeTruthy();
  const wellReads = bridge.invoke.mock.calls.filter(
    ([command, args]) =>
      command === "find_tickets" &&
      (args as { filter?: { status?: string } })?.filter?.status,
  );
  expect(wellReads).toHaveLength(6);
});

test("a failed Board status stays on its card with anchored Details and the same Retry intent", async () => {
  let tickets = [bulkTicket(1), bulkTicket(2)];
  let rejectSave: (reason: Error) => void = () => {};
  let fail = true;
  act(() => setPreference("ticketLayout", "board"));
  await renderBulk({
    find_tickets: ({ filter }: { filter: { status: string | null } }) =>
      tickets.filter(
        (ticket) => !filter.status || ticket.status === filter.status,
      ),
    count_tickets: ({ filter }: { filter: { status: string | null } }) =>
      counted({
        todo:
          filter.status && filter.status !== "Todo"
            ? 0
            : tickets.filter((ticket) => ticket.status === "Todo").length,
        in_progress:
          filter.status && filter.status !== "In progress"
            ? 0
            : tickets.filter((ticket) => ticket.status === "In progress")
                .length,
      }),
    show_ticket: ({ reference }: { reference: string }) =>
      tickets.find((ticket) => ticket.reference === reference),
    change_ticket: ({
      reference,
      patch,
    }: {
      reference: string;
      patch: { status: string };
    }) => {
      if (fail)
        return new Promise((_resolve, reject) => {
          rejectSave = reject;
        });
      tickets = tickets.map((ticket) =>
        ticket.reference === reference ? { ...ticket, ...patch } : ticket,
      );
      return tickets.find((ticket) => ticket.reference === reference);
    },
  });
  const next = screen.getByRole("button", { name: /T-KQ2.*Second/ });
  openMenu("Change status of T-KQ1, current status: Todo");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "In progress" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    rejectSave(new Error("SYNTHETIC_BOARD_SAVE_CAUSE"));
    await vi.advanceTimersByTimeAsync(0);
  });
  const failure = screen.getByRole("alert");
  expect(failure.textContent).toContain("Not saved");
  expect(failure.textContent).not.toContain("SYNTHETIC_BOARD_SAVE_CAUSE");
  expect(screen.getByRole("button", { name: /T-KQ2.*Second/ })).toBe(next);
  fireEvent.click(within(failure).getByRole("button", { name: "Details" }));
  const details = screen.getByRole("dialog", { name: "Failure details" });
  expect(within(details).getByText(/SYNTHETIC_BOARD_SAVE_CAUSE/)).toBeTruthy();
  fireEvent.keyDown(details, { key: "Escape" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fail = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry status change for T-KQ1" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "change_ticket",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]?.[1]).toEqual(writes[0]?.[1]);
  expect(screen.queryByRole("alert")).toBeNull();
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
  await foldSidebar();
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
  await foldSidebar();
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

test("a palette status change shows on the list row at once, before the list is read again", async () => {
  vi.useFakeTimers();
  let current = bulkTicket(1, { reference: "T-FV1", title: "Palette target" });
  // After the write the list read is still on its way.
  let listRead: Promise<unknown> | null = null;
  bridge.invoke.mockImplementation(
    (command: string, args?: { patch?: { status?: string } }) => {
      if (command === "find_tickets")
        return listRead ?? Promise.resolve([current]);
      if (command === "show_ticket") return current;
      if (command === "change_ticket") {
        current = { ...current, status: args?.patch?.status ?? current.status };
        listRead = new Promise(() => {});
        return current;
      }
      return bridgeDefault(command);
    },
  );
  const turn = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  render(<App />);
  await turn();
  const row = screen.getByRole("button", { name: /Palette target/ });
  row.focus();
  fireEvent.keyDown(row, { key: "s" });
  await turn();
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Search tickets and destinations" }),
    { key: "4" },
  );
  for (let i = 0; i < 4; i += 1) await turn();
  expect(screen.getByText("Moved T-FV1 to Done")).toBeTruthy();
  // The row keeps its place (the list holds a moved row still), but shows the new status.
  expect(
    screen
      .getByRole("button", { name: /Palette target/ })
      .getAttribute("data-status"),
  ).toBe("Done");
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

test("a closed palette stops reading its Ticket when the workspace changes", async () => {
  vi.useFakeTimers();
  paletteTickets();
  render(<App />);
  const turn = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  await turn();
  const row = screen.getByRole("button", { name: /Focused Ticket/ });
  row.focus();
  fireEvent.keyDown(row, { key: "k", ctrlKey: true });
  await turn();
  const input = screen.getByRole("combobox", {
    name: "Search tickets and destinations",
  });
  await turn();
  fireEvent.keyDown(input, { key: "Escape" });
  await turn();
  expect(
    screen.queryByRole("combobox", { name: "Search tickets and destinations" }),
  ).toBeNull();
  const reads = () =>
    bridge.invoke.mock.calls.filter(
      ([command, args]) =>
        command === "show_ticket" &&
        (args as { reference: string }).reference === "T-KQ2",
    ).length;
  const before = reads();
  // Every poll sees a moved token, so each is a change made elsewhere.
  for (let poll = 0; poll < 3; poll += 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
  expect(reads()).toBe(before);
});

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

test("Copy reference exposes its shortcut in the header tooltip and accessible metadata", async () => {
  const user = userEvent.setup();
  paletteTickets();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /Open Ticket/ }));
  const copy = await screen.findByRole("button", { name: "Copy reference" });
  expect(copy.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+C");
  await user.hover(copy);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("Copy reference");
  expect(tooltip.textContent).toContain("Ctrl+Shift+C");
});

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

test("workspace Retry keeps the band and Details until a writable check succeeds", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: /^All tickets/ });
  act(() => reportWorkspaceFailure("workspace_read_only", "raw readonly"));
  const message = "This workspace is read-only. Changes can't be saved.";
  const band = screen.getByText(message).closest("[data-slot=workspace-band]")!;
  fireEvent.click(
    within(band as HTMLElement).getByRole("button", { name: "Details" }),
  );
  const details = await screen.findByRole("dialog", {
    name: "Failure details",
  });
  expect(details.textContent).toContain("raw readonly");
  expect(band.contains(details)).toBe(false);
  expect(
    within(details).getByRole("button", { name: "Copy details" }),
  ).toBeTruthy();
  fireEvent.keyDown(details, { key: "Escape" });
  let finish: ((value: unknown) => void) | undefined;
  bridge.invoke.mockImplementation((command: string) =>
    command === "sidebar_counts"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : bridgeDefault(command),
  );
  fireEvent.click(
    within(band as HTMLElement).getByRole("button", { name: "Retry" }),
  );
  expect(screen.getByText(message)).toBeTruthy();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await act(async () => finish?.(bridgeDefault("sidebar_counts")));
  await vi.waitFor(() => expect(screen.queryByText(message)).toBeNull());
});

test("failed workspace Retry keeps its band and a later success cannot clear a newer failure", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: /^All tickets/ });
  act(() => reportWorkspaceFailure("workspace_read_only", "raw readonly"));
  const message = "This workspace is read-only. Changes can't be saved.";
  let rejectCheck: ((reason: unknown) => void) | undefined;
  bridge.invoke.mockImplementation((command: string) =>
    command === "sidebar_counts"
      ? new Promise((_, reject) => {
          rejectCheck = reject;
        })
      : bridgeDefault(command),
  );
  const band = screen
    .getByText(message)
    .closest("[data-slot=workspace-band]") as HTMLElement;
  fireEvent.click(within(band).getByRole("button", { name: "Retry" }));
  expect(screen.getByText(message)).toBeTruthy();
  await vi.waitFor(() => expect(rejectCheck).toBeTypeOf("function"));
  await act(async () =>
    rejectCheck?.({ code: "workspace_read_only", message: "raw readonly" }),
  );
  expect(screen.getByText(message)).toBeTruthy();
  let finish: ((value: unknown) => void) | undefined;
  bridge.invoke.mockImplementation((command: string) =>
    command === "sidebar_counts"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : bridgeDefault(command),
  );
  fireEvent.click(within(band).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  // Even another failure with the same words belongs to a newer attempt.
  act(() => reportWorkspaceFailure("workspace_read_only", "raw readonly"));
  await act(async () => finish?.(bridgeDefault("sidebar_counts")));
  expect(screen.getByText(message)).toBeTruthy();
});

test("workspace Retry protects queued Capture edits before clearing the band", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  let writable = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { draft?: { revision: number }; body?: string },
    ) => {
      if (command === "draft_retentions") return [];
      if (command === "draft_cutover_pending") return false;
      if (command === "retain_draft") {
        if (!writable)
          throw { code: "workspace_read_only", message: "raw readonly" };
        await gate;
        return { ...args?.draft, revision: (args?.draft?.revision ?? 0) + 1 };
      }
      if (command === "save_document")
        return {
          id: "queued-capture",
          title: null,
          body: args?.body ?? "",
          created_at: "2030-01-01",
          updated_at: "2030-01-01",
          trashed: false,
        };
      return bridgeDefault(command);
    },
  );
  render(
    <DraftRecoveryProvider>
      <App />
    </DraftRecoveryProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const editor = screen.getByRole("textbox", { name: "Your thought source" });
  fireEvent.change(editor, { target: { value: "First draft" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  fireEvent.change(editor, { target: { value: "Keep the newer draft too" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const message = "This workspace is read-only. Changes can't be saved.";
  const band = screen
    .getByText(message)
    .closest("[data-slot=workspace-band]") as HTMLElement;
  writable = true;
  bridge.invoke.mockClear();
  fireEvent.click(within(band).getByRole("button", { name: "Retry" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText(message)).toBeTruthy();
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "sidebar_counts"),
  ).toBe(false);
  expect(editor).toHaveProperty("value", "Keep the newer draft too");
  await act(async () => {
    release?.();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByText(message)).toBeNull();
  expect(editor).toHaveProperty("value", "Keep the newer draft too");
});

test("reading another view cannot dismiss a workspace lock while Retry is still pending", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: /^All tickets/ });
  act(() => reportWorkspaceFailure("workspace_locked", "raw locked"));
  let reject: ((reason: unknown) => void) | undefined;
  bridge.invoke.mockImplementation((command: string, args) =>
    command === "sidebar_counts"
      ? new Promise((_, fail) => {
          reject = fail;
        })
      : bridgeDefault(command, args),
  );
  const message =
    "Another ticketd operation is using this workspace. Changes can't be saved right now.";
  const band = screen
    .getByText(message)
    .closest("[data-slot=workspace-band]") as HTMLElement;
  fireEvent.click(within(band).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  await screen.findByRole("heading", { name: "Documents" });
  expect(screen.getByText(message)).toBeTruthy();
  await act(async () =>
    reject?.({ code: "workspace_locked", message: "raw locked" }),
  );
  expect(screen.getByText(message)).toBeTruthy();
});

test("startup permission recovery opens the App without a stale workspace band", async () => {
  let readable = false;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "draft_retentions") {
      if (!readable)
        throw {
          code: "workspace_unreadable",
          message: "raw permission denied",
        };
      return [];
    }
    if (command === "draft_cutover_pending") return false;
    return bridgeDefault(command, args);
  });
  render(
    <DraftRecoveryProvider>
      <App />
    </DraftRecoveryProvider>,
  );
  await screen.findByRole("heading", {
    name: "ticketd can't open this workspace",
  });
  readable = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: /^All tickets/ });
  expect(
    screen.queryByText(
      "ticketd can't read this workspace file. Changes can't be saved.",
    ),
  ).toBeNull();
});

test.each(["palette", "chip"])(
  "%s custom reminder refuses past times and rechecks an expired draft before saving",
  async (route) => {
    paletteTickets();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date(2030, 0, 1, 10).getTime());
    try {
      render(<App />);
      const row = await screen.findByRole("button", { name: /Focused Ticket/ });
      if (route === "palette") {
        row.focus();
        fireEvent.keyDown(row, { key: "h" });
      } else {
        fireEvent.click(row);
        fireEvent.keyDown(
          await screen.findByRole("button", { name: "Add ticket property" }),
          { key: "Enter" },
        );
        fireEvent.click(
          await screen.findByRole("menuitem", { name: "Reminder" }),
        );
      }
      fireEvent.click(await screen.findByRole("option", { name: "Custom…" }));
      const field = await screen.findByLabelText("Date and time");
      fireEvent.change(field, { target: { value: "2030-01-01T09:00" } });
      expect(
        screen.getByText("This time has passed. Choose a future time."),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Set reminder" }),
      ).toHaveProperty("disabled", true);
      fireEvent.change(field, { target: { value: "2030-01-01T11:00" } });
      const submit = screen.getByRole("button", { name: "Set reminder" });
      expect(submit).toHaveProperty("disabled", false);
      now.mockReturnValue(new Date(2030, 0, 1, 12).getTime());
      fireEvent.click(submit);
      expect(
        screen.getByText("This time has passed. Choose a future time."),
      ).toBeTruthy();
      expect(
        bridge.invoke.mock.calls.some(
          ([command]) => command === "set_reminder",
        ),
      ).toBe(false);
    } finally {
      now.mockRestore();
    }
  },
);

test("Reminder H retries the same due time and request, then Undo restores its original due time", async () => {
  const user = userEvent.setup();
  const originalDue = "2030-01-01T09:00:00Z";
  let failed = false;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "find_tickets") return [bulkTicket(1)];
    if (command === "show_ticket") return bulkTicket(1);
    if (command === "reminder") return originalDue;
    if (command === "set_reminder") {
      if (!failed) {
        failed = true;
        throw new Error("Reminder temporarily unavailable");
      }
      return null;
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  const row = await screen.findByRole("button", { name: /First/ });
  row.focus();
  await user.keyboard("h");
  await user.click(await screen.findByRole("option", { name: /^Tomorrow/ }));
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  const requests = bridge.invoke.mock.calls.filter(
    ([command]) => command === "set_reminder",
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]?.[1]).toEqual(requests[1]?.[1]);
  await user.click(await screen.findByRole("button", { name: "Undo" }));
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "set_reminder",
      expect.objectContaining({ reference: "T-KQ1", dueAt: originalDue }),
    ),
  );
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
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(document.activeElement).toBe(target);
  act(() => target.blur());
  expect(document.activeElement).toBe(document.body);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(order()).toEqual(["T-KQ1", "T-KQ2", "T-KQ3"]);
  act(() => target.focus());
  vi.useRealTimers();
  fireEvent.keyDown(target, { key: "j" });
  const next = screen.getByRole("button", { name: /Next target/ });
  expect(document.activeElement).toBe(next);
  expect(order()).toEqual(["T-KQ2", "T-KQ3", "T-KQ1"]);
  expect(list.querySelector("li")?.getAttribute("data-status")).toBe(
    "In review",
  );
  expect(target.closest("li")?.getAttribute("data-arrival-fill")).toBe("true");
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByRole("heading", { name: "Todo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("heading", { name: "All tickets" }));
    expect(screen.queryByRole("heading", { name: "Todo" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
    expect(row.closest("li")?.getAttribute("data-arrival-fill")).toBe("true");
    if (reducedMotion) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(row.closest("li")?.hasAttribute("data-arrival-fill")).toBe(false);
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

test("checked rows keep their live-update positions through idle until selection is cleared", async () => {
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
  expect(screen.getByRole("heading", { name: "Todo" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
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
  tickets.push(
    ...[
      "In progress",
      "In progress",
      "In review",
      "Done",
      "Done",
      "Done",
      "Done",
      "Canceled",
      "Duplicate",
      "Duplicate",
    ].map((status, index) =>
      bulkTicket(index + 20, {
        title: `Counted member ${index}`,
        status,
        availability: null,
      }),
    ),
  );
  tickets.forEach((ticket) => {
    Object.assign(ticket, { project_id: "project" });
  });
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

test("a long Next up title keeps its ticket, Plan and spec separately keyboard reachable", async () => {
  const title = "A very long next ticket title ".repeat(15).trim();
  const ticket = bulkTicket(15, { title, availability: "Ready" });
  const plan = {
    id: "P-next",
    name: "Next release",
    archived: false,
    spec_document_id: "next-spec",
  };
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 1 }),
          members: [ticket],
          documents: [
            { id: "next-spec", heading: "Next specification", trashed: false },
          ],
        };
      if (command === "find_tickets") return [ticket];
      if (command === "show_ticket") return ticket;
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Plans" }));
  const cards = await screen.findByRole("list", { name: "Active Plans" });
  const openPlan = within(cards).getByRole("button", {
    name: "Open Plan Next release",
  });
  const next = await within(cards).findByRole("button", {
    name: `T-KQ15 ${title}`,
  });
  openPlan.focus();
  await user.tab();
  expect(document.activeElement).toBe(next);
  expect(within(cards).getByText("Ready", { exact: true })).toBeTruthy();
  await user.tab();
  expect(document.activeElement).toBe(
    within(cards).getByRole("button", { name: "Next specification" }),
  );
  await user.tab({ shift: true });
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { name: "T-KQ15" })).toBeTruthy();
  expect(screen.getByDisplayValue(title)).toBe(
    screen.getByRole("textbox", { name: "Title" }),
  );
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
      if (command === "find_tickets")
        return [
          bulkTicket(1, {
            status: "Canceled",
            availability: null,
            updated_at: null,
          }),
          bulkTicket(2, {
            status: "Canceled",
            availability: null,
            updated_at: null,
          }),
        ];
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

test.each(["Ticket", "Document", "New ticket", "Capture"])(
  "%s slash Escape closes only Insert block and keeps editing focus",
  async (kind) => {
    const user = userEvent.setup();
    const stored = {
      id: "slash-document",
      title: "Slash document",
      body: "",
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
      trashed: false,
    };
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "find_tickets") return [bulkTicket(1)];
      if (command === "show_ticket") return bulkTicket(1);
      if (command === "recent_documents")
        return [{ id: stored.id, heading: stored.title }];
      if (command === "open_document" || command === "show_document")
        return stored;
      if (command === "document_tags") return [];
      if (command === "document_version") return [stored.updated_at, false];
      return bridgeDefault(command, args);
    });
    render(<App />);
    if (kind === "New ticket") {
      await user.click(sidebarNewTicket());
      await screen.findByRole("dialog", { name: "New ticket" });
      fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
        target: { value: "Kept new ticket" },
      });
    } else if (kind === "Capture") {
      await user.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
      await screen.findByRole("dialog", { name: "New Document" });
    } else if (kind === "Document") {
      await user.click(
        await screen.findByRole("button", { name: "Documents" }),
      );
      await user.click(
        await screen.findByRole("button", { name: stored.title }),
      );
      await user.click(await screen.findByRole("button", { name: "Edit" }));
    } else {
      await user.click(await screen.findByRole("button", { name: /First/ }));
      fireEvent.keyDown(document.body, { key: "e" });
    }
    const editor = await screen.findByRole("textbox", {
      name:
        kind === "Document"
          ? "Document rich text"
          : kind === "Capture"
            ? "Your thought rich text"
            : "Description rich text",
    });
    Object.defineProperty(editor, "isContentEditable", { value: true });
    editor.focus();
    fireEvent.keyDown(editor, { key: "/" });
    expect(
      await screen.findByRole("listbox", { name: "Insert block" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Insert block" })).toBeNull();
    if (kind === "Ticket" || kind === "Document")
      expect(screen.getByRole("group", { name: "Edit controls" })).toBeTruthy();
    else
      expect(
        screen.getByRole("dialog", {
          name: kind === "Capture" ? "New Document" : "New ticket",
        }),
      ).toBeTruthy();
    expect(document.activeElement).toBe(editor);
    expect(editor.isConnected).toBe(true);
  },
);

test("description editing keeps its state row and floats controls outside the prose", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets")
      return [bulkTicket(1, { id: "description-only", body: "A description" })];
    if (command === "show_ticket")
      return bulkTicket(1, { id: "description-only", body: "A description" });
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

test.each(["Escape", "Done"])(
  "%s leaves description editing without scrolling its reading surface",
  async (exit) => {
    bridge.invoke.mockImplementation((command: string) => {
      if (command === "find_tickets")
        return [bulkTicket(1, { body: "Keep the reading position" })];
      if (command === "show_ticket")
        return bulkTicket(1, { body: "Keep the reading position" });
      return bridgeDefault(command);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    fireEvent.click(await screen.findByText("Keep the reading position"));
    const editor = await screen.findByRole("textbox", {
      name: "Description rich text",
    });
    editor.focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      if (exit === "Escape") fireEvent.keyDown(editor, { key: "Escape" });
      else
        fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
      const reading = screen.getByRole("group", { name: "Read description" });
      await vi.waitFor(() => expect(document.activeElement).toBe(reading));
      const restoration = focus.mock.contexts.findIndex(
        (node) => node === reading,
      );
      expect(focus.mock.calls[restoration]?.[0]).toEqual({
        preventScroll: true,
      });
    } finally {
      focus.mockRestore();
    }
  },
);

test("description exit respects a newer focus choice", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets")
      return [bulkTicket(1, { body: "Keep typing in the title" })];
    if (command === "show_ticket")
      return bulkTicket(1, { body: "Keep typing in the title" });
    return bridgeDefault(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /First/ }));
  fireEvent.click(await screen.findByText("Keep typing in the title"));
  const editor = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor));
  const frames: FrameRequestCallback[] = [];
  const frame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  try {
    fireEvent.keyDown(editor, { key: "Escape" });
    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    act(() => frames.forEach((callback) => callback(0)));
    expect(document.activeElement).toBe(title);
  } finally {
    frame.mockRestore();
  }
});

test("highlighted description edits preserve canonical code and links, and copy the fence source", async () => {
  const code =
    "const shift = measureLayoutShift(board);\nexpect(shift).toBeLessThan(0.01);\n";
  const body =
    "Use `measureLayoutShift` and [design notes](https://example.com/design).\n\n- [ ] Keep the slot\n\n```typescript\n" +
    code +
    "```\n\n> Keep columns still.\n";
  let stored = bulkTicket(1, { body });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "find_tickets") return [stored];
    if (command === "show_ticket") return stored;
    if (command === "change_ticket") {
      stored = { ...stored, ...(args as { patch: { body: string } }).patch };
      return stored;
    }
    return bridgeDefault(command, args as { id?: string; reference?: string });
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /First/ }));
  const copy = await screen.findByRole("button", { name: "Copy code" });
  copy.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
  expect(
    screen.getByRole("link", { name: "design notes" }).getAttribute("href"),
  ).toBe("https://example.com/design");
  fireEvent.keyDown(document.body, { key: "e" });
  const checkbox = await screen.findByRole("checkbox", {
    name: "Checklist item",
  });
  expect(
    screen.getByRole("combobox", { name: "Code language" }),
  ).toHaveProperty("value", "TypeScript");
  expect(stored.body).toBe(body);
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "change_ticket"),
  ).toBe(false);
  fireEvent.click(checkbox);
  await vi.waitFor(() =>
    expect(stored.body).toBe(body.replace("[ ]", "[x]").trimEnd()),
  );
  const richCopy = screen.getByRole("button", { name: "Copy code" });
  richCopy.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(code));
  expect(stored.body).toBe(body.replace("[ ]", "[x]").trimEnd());
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  expect(screen.getByRole("link", { name: "design notes" })).toBeTruthy();
  expect(
    within(screen.getByRole("group", { name: "Read description" })).getByText(
      "Keep columns still.",
    ),
  ).toBeTruthy();
});

test("floating save feedback retains a failed description draft and retries it", async () => {
  let stored = bulkTicket(1, {
    id: "description-retry",
    body: "- [ ] Keep this draft",
  });
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
  expect(screen.getByText(/The result couldn't be confirmed/)).toBeTruthy();
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

test("Flow refuses to invent lanes when a Plan exceeds its bounded member window", async () => {
  const plan = { id: "P-bounded-flow", name: "Bounded flow", archived: false };
  const tickets = Array.from({ length: 501 }, (_, index) =>
    bulkTicket(index + 1, {
      title: `Bounded member ${index + 1}`,
      plan_id: plan.id,
    }),
  );
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
          members: tickets.slice(0, Number(args.limit ?? 501)),
          documents: [],
          counts: counted({ todo: 501 }),
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Plans" }));
  const cards = await screen.findByRole("list", { name: "Active Plans" });
  await within(cards).findByText("Couldn't load next ticket");
  expect(within(cards).queryByText("No Ready tickets")).toBeNull();
  fireEvent.click(
    within(cards).getByRole("button", { name: "Open Plan Bounded flow" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Flow" }));
  const flow = await screen.findByRole("region", { name: "Plan Flow" });
  await within(flow).findByText(/Couldn't load this Plan’s Flow/);
  expect(
    within(flow).getByText(/This Plan exceeds the complete Flow window/),
  ).toBeTruthy();
  expect(within(flow).queryByRole("button", { name: /T-KQ501/ })).toBeNull();
  expect(screen.queryByText("No Ready tickets")).toBeNull();
});

test("Flow refuses incomplete blocker metadata instead of calling hidden blockers outside work", async () => {
  const user = userEvent.setup();
  const plan = {
    id: "P-blocker-window",
    name: "Blocker window",
    archived: false,
  };
  const member = bulkTicket(1, {
    plan_id: plan.id,
    prerequisites: Array.from({ length: 51 }, (_, index) => ({
      reference: `T-KQ${index + 2}`,
      title: `Prerequisite ${index}`,
      status: "Todo",
      trashed: false,
      unresolved: true,
    })),
  });
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "list_plans") return [plan];
    if (command === "find_tickets") return [member];
    if (command === "show_plan")
      return {
        plan,
        counts: counted({ todo: 1 }),
        members: args?.includeMembers === false ? [] : [member],
        documents: [],
      };
    return bridgeDefault(command, args);
  });
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /^Blocker window/ }),
  );
  await user.click(screen.getByRole("radio", { name: "Flow" }));
  const flow = await screen.findByRole("region", { name: "Plan Flow" });
  await within(flow).findByText(/This Plan exceeds the complete Flow window/);
  expect(within(flow).queryByText(/outside this Plan/)).toBeNull();
  expect(screen.queryByText("No Ready tickets")).toBeNull();
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

test("Workspace graph bounds many Plan reads and exposes omitted islands for explicit expansion", async () => {
  const plans = Array.from({ length: 12 }, (_, index) => ({
    id: `budget-plan-${index}`,
    name: `Budget Plan ${index}`,
    archived: false,
  }));
  const reads: string[] = [];
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans")
        return args?.limit === undefined
          ? plans
          : plans.slice(
              Number(args.offset),
              Number(args.offset) + Number(args.limit),
            );
      if (command === "show_plan") {
        if (Number(args.limit) > 0 && args.includeMembers === false)
          reads.push(String(args.id));
        const plan = plans.find((plan) => plan.id === args.id)!;
        return { plan, members: [], documents: [], counts: counted({}) };
      }
      if (command === "workspace_graph")
        return {
          nodes: [],
          edges: [],
          omitted: false,
          omitted_groups: [],
          next_cursor: null,
          total: 12,
          node_tags: {},
        };
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await screen.findByRole("button", { name: "Workspace graph" });
  reads.length = 0;
  fireEvent.click(screen.getByRole("button", { name: "Workspace graph" }));
  const graph = screen.getByRole("region", { name: "Workspace graph" });
  await within(graph).findByText(/Some Plan islands are not loaded/);
  expect(reads.length).toBeLessThanOrEqual(8);
  fireEvent.click(within(graph).getByRole("button", { name: "Load more" }));
  await within(graph).findByText("Budget Plan 11");
  expect(reads.length).toBeLessThanOrEqual(12);
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

test("Workspace graph pages a large Plan without losing membership when connections expand", async () => {
  const user = userEvent.setup();
  const plan = { id: "P-window", name: "Windowed Plan", archived: false };
  const members = Array.from({ length: 130 }, (_, index) =>
    bulkTicket(index + 1, {
      title: `Window member ${index + 1}`,
      plan_id: plan.id,
    }),
  );
  const all = [
    {
      id: plan.id,
      kind: "plan",
      label: plan.name,
      state: "Active",
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
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 130 }),
          members: members.slice(
            Number(args.offset ?? 0),
            Number(args.offset ?? 0) + Number(args.limit ?? 130),
          ),
          documents: [],
        };
      if (command === "find_tickets") {
        const filter = args.filter as { offset: number; limit: number };
        return members.slice(filter.offset, filter.offset + filter.limit);
      }
      if (command === "show_ticket")
        return members.find((ticket) => ticket.reference === args.reference);
      if (command === "workspace_graph") {
        const request = args.request as {
          hydrate_only: boolean;
          visible_ids: string[];
        };
        return {
          nodes: request.hydrate_only
            ? all.filter((node) => request.visible_ids.includes(node.id))
            : [],
          edges: [],
          total: 131,
          next_cursor: null,
          omitted: true,
          omitted_groups: ["related"],
          node_tags: {},
        };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Workspace graph" }),
  );
  const graph = screen.getByRole("region", { name: "Workspace graph" });
  await within(graph).findByText("119 tickets, 0 Documents");
  expect(
    within(graph).getByText(/Some Plan tickets or Documents are not loaded/),
  ).toBeTruthy();
  await user.click(within(graph).getByRole("button", { name: "Load more" }));
  await within(graph).findByText("11 tickets, 0 Documents");
  expect(within(graph).queryByText(/Not in a Plan/)).toBeNull();
  await user.click(within(graph).getByRole("radio", { name: "List" }));
  expect(
    within(graph).getByRole("button", { name: "T-KQ130 · Window member 130" }),
  ).toBeTruthy();
  expect(
    within(graph).queryByRole("button", { name: "T-KQ1 · Window member 1" }),
  ).toBeNull();
  await user.click(
    within(graph).getByRole("button", { name: "Show more connections" }),
  );
  await within(graph).findByText(/Showing 12 of 131 items/);
  expect(
    within(graph).getByRole("button", { name: "T-KQ130 · Window member 130" }),
  ).toBeTruthy();
  expect(
    within(graph).queryByRole("button", { name: "T-KQ1 · Window member 1" }),
  ).toBeNull();
  expect(within(graph).getByText(/Showing 12 of 131 items/)).toBeTruthy();
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
          edges:
            nodes.some((node) => node.id === members[100]!.id) &&
            nodes.some((node) => node.id === members[0]!.id)
              ? [
                  {
                    source: members[100]!.id,
                    target: members[0]!.id,
                    kind: "blocks",
                    explanation: null,
                  },
                ]
              : [],
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
    within(graph).queryByText(
      /Some connections across the 100-item graph limit/,
    ),
  ).toBeNull();
});
test.each([
  [true, "1"],
  [false, "2"],
  [true, "3"],
] as const)(
  "ticket agent strip and Inbox follow approval answer (focused: %s, choice: %s)",
  async (focused, choice) => {
    const user = userEvent.setup();
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
      const box = screen.getByRole("textbox", { name: /Codex/ });
      if (choice === "1") {
        box.focus();
        await user.keyboard("1j23");
        expect(box).toHaveProperty("value", "1j23");
        expect(answer).not.toHaveBeenCalled();
        await user.clear(box);
        screen.getByRole("button", { name: /^Codex, model/ }).focus();
        await user.keyboard("{Enter}");
        await screen.findByRole("dialog", { name: "Harness and model" });
        await user.keyboard("123");
        expect(answer).not.toHaveBeenCalled();
        await user.keyboard("{Escape}");
      }
      const allow = screen.getByRole("button", { name: "Allow once" });
      allow.focus();
      if (choice === "1") {
        await user.keyboard("{ArrowDown}{ArrowDown}");
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Decline" }),
        );
        await user.keyboard("{ArrowUp}{ArrowUp}");
        expect(document.activeElement).toBe(allow);
      }
      await user.keyboard(choice);
      await vi.waitFor(() =>
        expect(answer).toHaveBeenCalledWith("strip-chat", "approval", {
          option_id:
            choice === "1" ? "allow" : choice === "2" ? "session" : "deny",
        }),
      );
      expect(
        await screen.findByRole("button", { name: "Chats, 1 working" }),
      ).toBeTruthy();
      expect(document.activeElement).toBe(box);
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

test.each([false, true])(
  "ticket agent late start keeps the focused reference and header state until the next opening (narrow: %s)",
  async (narrow) => {
    narrowViewport = narrow;
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
    const copy = screen.getByRole("button", { name: "Copy reference" });
    act(() => copy.focus());
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
    expect(document.activeElement).toBe(copy);
    act(() =>
      client.push("late", {
        kind: "request",
        id: "late-approval",
        at: "2026-11-16T00:00:00Z",
        request: "approval",
        title: "Run the check",
        command: "npm test -- board",
        options: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Decline" },
        ],
        state: "pending",
        free_text: false,
      }),
    );
    await within(header as HTMLElement).findByRole("button", {
      name: "Review request",
    });
    expect(
      within(header as HTMLElement).getByText("Approval needed"),
    ).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Ticket agent" })).toBeNull();
    expect(document.activeElement).toBe(copy);
    await act(async () => {
      await client.answer("late", "late-approval", { option_id: "allow" });
      client.patch("late", { activity: "idle" });
    });
    expect(
      within(header as HTMLElement).queryByRole("status", { name: "Working" }),
    ).toBeNull();
    expect(
      within(header as HTMLElement).queryByRole("button", {
        name: "Review request",
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Copy reference" })).toBe(copy);
    expect(document.activeElement).toBe(copy);
    act(() =>
      client.push("late", {
        kind: "request",
        id: "route-approval",
        at: "2026-11-16T00:00:00Z",
        request: "approval",
        title: "Run the check",
        command: "npm test -- board",
        options: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Decline" },
        ],
        state: "pending",
        free_text: false,
      }),
    );
    const review = await within(header as HTMLElement).findByRole("button", {
      name: "Review request",
    });
    fireEvent.click(review);
    expect(
      await screen.findByRole("heading", { name: "Late Chat" }),
    ).toBeTruthy();
    expect(await screen.findByText("npm test -- board")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to T-KQ2" }));
    await screen.findByRole("button", { name: "Copy reference" });
    expect(
      within(
        screen
          .getByRole("heading", { name: "T-KQ2" })
          .closest(".detail-header") as HTMLElement,
      ).queryByText("Approval needed"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Close ticket/ }));
    fireEvent.click(screen.getByRole("button", { name: /Focused Ticket/ }));
    expect(
      await screen.findByRole("status", { name: "Ticket agent" }),
    ).toBeTruthy();
  },
);

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

test.each(["All tickets", "Plan"])(
  "pointer Status filter in %s commits after close and returns focus",
  async (scope) => {
    const user = userEvent.setup();
    const tickets = [
      bulkTicket(1, { title: "Todo pointer row", status: "Todo" }),
      bulkTicket(2, { title: "Done pointer row", status: "Done" }),
    ];
    bridge.invoke.mockImplementation((command: string, args?: object) => {
      if (command === "list_plans")
        return [{ id: "pointer-plan", name: "Pointer Plan", archived: false }];
      if (command === "show_plan") {
        const view = bridgeDefault(command, args) as { plan: object };
        return {
          ...view,
          plan: { ...view.plan, id: "pointer-plan", name: "Pointer Plan" },
          members: tickets,
        };
      }
      if (command === "find_tickets") {
        const status = (args as { filter: { status: string | null } }).filter
          .status;
        return status
          ? tickets.filter((ticket) => ticket.status === status)
          : tickets;
      }
      return bridgeDefault(command, args);
    });
    render(<App />);
    await screen.findByRole("button", { name: /Done pointer row/ });
    if (scope === "Plan") {
      await user.click(screen.getByRole("button", { name: "Pointer Plan" }));
      await user.click(
        await screen.findByRole("button", { name: "Plan actions" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Filter and display…" }),
      );
    }
    const trigger = await screen.findByRole("button", { name: "Filters" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: /^Status/ }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Todo/ }),
    );
    const bar = await screen.findByLabelText("Active filters");
    expect(bar.textContent).toContain("StatusTodo");
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Done pointer row/ }),
      ).toBeNull();
      expect(screen.queryAllByRole("menu")).toHaveLength(0);
      expect(document.activeElement).toBe(trigger);
    });
    expect(bridge.invoke).toHaveBeenCalledWith("find_tickets", {
      filter: expect.objectContaining({ status: "Todo" }),
    });
  },
);

test.each(["All tickets", "Plan"])(
  "pointer Tags filter in %s keeps multiple checks staged until dismissal",
  async (scope) => {
    const user = userEvent.setup();
    const tickets = [
      bulkTicket(1, { title: "Both pointer tags", tags: ["board", "ui"] }),
      bulkTicket(2, { title: "Other pointer row", tags: [] }),
    ];
    bridge.invoke.mockImplementation((command: string, args?: object) => {
      if (command === "list_plans")
        return [{ id: "pointer-plan", name: "Pointer Plan", archived: false }];
      if (command === "show_plan") {
        const view = bridgeDefault(command, args) as { plan: object };
        return {
          ...view,
          plan: { ...view.plan, id: "pointer-plan", name: "Pointer Plan" },
          members: tickets,
        };
      }
      if (command === "search_tags") return ["board", "ui"];
      if (command === "find_tickets") {
        const tags = (args as { filter: { tags: string[] } }).filter.tags;
        return tags.length ? tickets.slice(0, 1) : tickets;
      }
      return bridgeDefault(command, args);
    });
    render(<App />);
    await screen.findByRole("button", { name: /Other pointer row/ });
    if (scope === "Plan") {
      await user.click(screen.getByRole("button", { name: "Pointer Plan" }));
      await user.click(
        await screen.findByRole("button", { name: "Plan actions" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Filter and display…" }),
      );
    }
    const retained = await screen.findByRole("button", {
      name: /Other pointer row/,
    });
    const trigger = await screen.findByRole("button", { name: "Filters" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: /^Tags/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "board" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "ui" }));
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "board" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "ui" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByLabelText("Active filters")).toBeNull();
    expect(retained.isConnected).toBe(true);
    expect(
      bridge.invoke.mock.calls
        .filter(([name]) => name === "find_tickets")
        .at(-1)?.[1],
    ).toEqual(
      expect.objectContaining({
        filter: expect.objectContaining({ tags: [] }),
      }),
    );
    await user.keyboard("{Escape}");
    const bar = await screen.findByLabelText("Active filters");
    expect(bar.textContent).toContain("Tagsboard, ui");
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Other pointer row/ }),
      ).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    expect(bridge.invoke).toHaveBeenCalledWith("find_tickets", {
      filter: expect.objectContaining({ tags: ["board", "ui"] }),
    });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: /^Tags/ }));
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "board" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "ui" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  },
);

test("leaving a focused filter submenu cancels the earlier pointer hover opening intent", async () => {
  bridge.invoke.mockImplementation((command: string, args?: object) => {
    if (command === "search_tags") return ["board", "ui"];
    if (command === "find_tickets")
      return [bulkTicket(1, { title: "Intent row" })];
    return bridgeDefault(command, args);
  });
  render(<App />);
  await screen.findByRole("button", { name: /Intent row/ });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
  try {
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const tags = screen.getByRole("menuitem", { name: "Tags" });
    await user.hover(tags);
    await user.click(tags);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemcheckbox", { name: "board" }),
    );
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("menu", { name: "Tags" })).toBeNull();
    expect(document.activeElement).toBe(tags);
    // The old hover timer must not reopen a submenu the person just left.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(101);
    });
    expect(screen.queryByRole("menu", { name: "Tags" })).toBeNull();
    expect(document.activeElement).toBe(tags);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menu", { name: "Tags" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemcheckbox", { name: "board" }),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("filter drafts keep every tag and Status when keyboard selection closes a pointer-opened menu", async () => {
  const user = userEvent.setup();
  const tickets = [
    bulkTicket(1, {
      title: "Both draft tags",
      status: "Todo",
      tags: ["board", "ui"],
    }),
    bulkTicket(2, { title: "Other draft row", status: "Done", tags: [] }),
  ];
  bridge.invoke.mockImplementation((command: string, args?: object) => {
    if (command === "search_tags") return ["board", "ui"];
    if (command === "find_tickets") {
      const filter = (
        args as { filter: { status: string | null; tags: string[] } }
      ).filter;
      return tickets.filter(
        (ticket) =>
          (!filter.status || ticket.status === filter.status) &&
          filter.tags.every((tag) => ticket.tags.includes(tag)),
      );
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  const retained = await screen.findByRole("button", {
    name: /Other draft row/,
  });
  const trigger = screen.getByRole("button", { name: "Filters" });
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: /^Tags/ }));
  await user.click(
    await screen.findByRole("menuitemcheckbox", { name: "board" }),
  );
  await user.click(screen.getByRole("menuitemcheckbox", { name: "ui" }));
  expect(screen.queryByLabelText("Active filters")).toBeNull();
  expect(retained.isConnected).toBe(true);
  // Move back to the parent dimension and choose Status with the keyboard.
  await user.keyboard("{ArrowLeft}{Home}{ArrowRight}{End}{Enter}");
  const bar = await screen.findByLabelText("Active filters");
  expect(bar.textContent).toContain("StatusDuplicate");
  expect(bar.textContent).toContain("Tagsboard, ui");
  await waitFor(() => expect(screen.queryAllByRole("menu")).toHaveLength(0));
  expect(document.activeElement).toBe(trigger);
  await screen.findByText("No tickets match these filters");
  expect(
    screen.queryByRole("heading", { name: "Your workspace is ready" }),
  ).toBeNull();
  expect(
    screen.getByText("Nothing in All tickets matches the 2 filters on."),
  ).toBeTruthy();
  expect(
    bridge.invoke.mock.calls
      .filter(([name]) => name === "find_tickets")
      .map(([, args]) => args),
  ).toEqual([
    expect.objectContaining({
      filter: expect.objectContaining({ status: null, tags: [] }),
    }),
    expect.objectContaining({
      filter: expect.objectContaining({
        status: "Duplicate",
        tags: ["board", "ui"],
      }),
    }),
  ]);
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: /^Tags/ }));
  for (const tag of ["board", "ui"])
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: tag })
        .getAttribute("aria-checked"),
    ).toBe("true");
  await user.keyboard("{Escape}");
  await user.click(within(bar).getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("button", { name: /Other draft row/ });
  expect(screen.queryByLabelText("Active filters")).toBeNull();
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
  // The bar sits in its Expand, which follows the header.
  expect(
    bar
      .closest('[data-slot="expand"]')
      ?.previousElementSibling?.getAttribute("data-slot"),
  ).toBe("pane-header");
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

test("Chats distinguishes an unknown list from empty and keeps known rows after a failed refresh", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient, chatState } =
    await import("@/features/chats/mock-client");
  const client = createMockChatClient({
    enabled: true,
    chats: [{ chat: chatState({ id: "known", title: "Known Chat" }) }],
  });
  const read = client.listChats.bind(client);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const list = vi
    .spyOn(client, "listChats")
    .mockImplementation(async (scope) => {
      await waiting;
      throw new Error(`Synthetic initial ${scope} read failure`);
    });
  bridge.invoke.mockImplementation(bridgeDefault);
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Chats" }));
  const pane = screen.getByRole("region", { name: "Chat list" });
  expect(
    within(pane).getByRole("status", { name: "Loading Chats" }),
  ).toBeTruthy();
  expect(within(pane).queryByText("0")).toBeNull();
  expect(within(pane).queryByText("No Chats yet")).toBeNull();
  await act(async () => release());
  expect(
    await within(pane).findByRole("button", { name: "Retry" }),
  ).toBeTruthy();
  expect(within(pane).queryByText("0")).toBeNull();
  list.mockImplementation(read);
  fireEvent.click(within(pane).getByRole("button", { name: "Retry" }));
  expect(
    await within(pane).findByRole("button", { name: /Known Chat,/ }),
  ).toBeTruthy();
  expect(within(pane).getByText("1")).toBeTruthy();
  list.mockRejectedValueOnce(new Error("Synthetic read failure"));
  await act(async () => client.patch("known", { title: "Known Chat" }));
  expect(
    await within(pane).findByRole("button", { name: "Retry" }),
  ).toBeTruthy();
  expect(
    within(pane).getByRole("button", { name: /Known Chat,/ }),
  ).toBeTruthy();
  expect(within(pane).getByText("1")).toBeTruthy();
  fireEvent.click(within(pane).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(within(pane).queryByRole("button", { name: "Retry" })).toBeNull(),
  );
});

test.each([false, true])(
  "New Chat Retry keeps the draft and creation identity follows payload edits (%s)",
  async (edited) => {
    const { ChatClientContext } = await import("@/features/chats/client");
    const { createMockChatClient } =
      await import("@/features/chats/mock-client");
    const client = createMockChatClient({ enabled: true });
    const create = vi
      .spyOn(client, "createChat")
      .mockRejectedValueOnce(new Error("Synthetic refusal"));
    bridge.invoke.mockImplementation(bridgeDefault);
    render(
      <ChatClientContext value={client}>
        <App />
      </ChatClientContext>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Chats" }));
    const input = await screen.findByRole("textbox", {
      name: "Describe a task or ask a question",
    });
    fireEvent.change(input, { target: { value: "Keep these words" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(input).toHaveProperty("value", "Keep these words");
    if (edited) {
      fireEvent.change(input, { target: { value: "Edited words" } });
      fireEvent.click(
        screen.getByRole("button", {
          name: "Claude Code, model Opus 5.5, effort Default",
        }),
      );
      fireEvent.click(screen.getByRole("radio", { name: "High" }));
      fireEvent.keyDown(document.body, { key: "Escape" });
    }
    fireEvent.click(retry);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    if (edited) {
      expect(create.mock.calls[1]?.[0].command_id).not.toBe(
        create.mock.calls[0]?.[0].command_id,
      );
      expect(create.mock.calls[1]?.[0].message).toBe("Edited words");
      expect(create.mock.calls[1]?.[0].effort).toBe("high");
    } else expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    expect(client.created).toHaveLength(1);
  },
);

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
  const user = userEvent.setup();
  const current = bulkTicket(1, { title: "Evidence outcome" });
  let items: import("@/lib/api/client").Evidence[] = [];
  const writes = new Map<string, import("@/lib/api/client").Evidence>();
  let replyLost = false;
  let deleteFailed = false;
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
        if (!deleteFailed) {
          deleteFailed = true;
          throw new Error("SYNTHETIC_DELETE_FAILURE");
        }
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
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add evidence" })).toBeNull(),
  );
  await vi.waitFor(() => expect(actions.hasAttribute("disabled")).toBe(false));
  expect(actions.isConnected).toBe(true);
  screen.getByRole("button", { name: "Actions for Review" }).focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete" }, { timeout: 1500 }),
  );
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("Couldn't delete the evidence");
  expect(
    screen.getByRole("button", { name: "Actions for Review" }),
  ).toBeTruthy();
  await user.click(within(failure).getByRole("button", { name: "Retry" }));
  await user.click(await screen.findByRole("button", { name: "Undo" }));
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Actions for Review" });
  expect(
    screen.getAllByRole("button", { name: "Actions for Review" }),
  ).toHaveLength(1);
  // A keyboard selection reaches the same immediate removal and Undo.
  screen.getByRole("button", { name: "Actions for Review" }).focus();
  await user.keyboard("{Enter}");
  await user.keyboard("{End}{Enter}");
  await user.click(await screen.findByRole("button", { name: "Undo" }));
  expect(
    await screen.findByRole("button", { name: "Actions for Review" }),
  ).toBeTruthy();
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

test("Inbox triage accepts review with Undo, keeps the reading queue still, and uses the folded Activity composer", async () => {
  await import("@/features/markdown/MarkdownEditor");
  let first = bulkTicket(1, { status: "In review" });
  const second = bulkTicket(2);
  let due: string | null = "2020-01-01T00:00:00Z";
  const timestamp = "2026-11-15T00:00:00Z";
  let entries = [
    {
      id: 201,
      reference: "T-KQ1",
      title: "First",
      kind: "status",
      from_value: "In progress",
      to_value: "In review",
      timestamp,
      editing_agent: "codex",
      read: false,
    },
    {
      id: 202,
      reference: "T-KQ2",
      title: "Second",
      kind: "reminder",
      from_value: "",
      to_value: due,
      timestamp,
      editing_agent: null,
      read: false,
    },
  ];
  await renderBulk({
    attachment_workspace_id: () => "triage-test",
    latest_update: () => null,
    is_following: () => false,
    find_tickets: () => [first, second],
    show_ticket: ({ reference }: { reference: string }) =>
      reference === "T-KQ1" ? first : second,
    ticket_history: ({ reference }: { reference: string }) =>
      reference === "T-KQ1"
        ? [
            {
              kind: "status",
              from_value: "In progress",
              to_value: first.status,
              timestamp,
              editing_agent: "codex",
            },
          ]
        : [],
    reminder: ({ reference }: { reference: string }) =>
      reference === "T-KQ2" ? due : null,
    inbox: () => entries,
    set_inbox_read: ({ ids, read }: { ids: number[]; read: boolean }) => {
      entries = entries.map((entry) =>
        ids.includes(entry.id) ? { ...entry, read } : entry,
      );
    },
    change_ticket: ({ patch }: { patch: { status: string } }) => {
      first = { ...first, status: patch.status };
      return first;
    },
    set_reminder: ({ dueAt }: { dueAt: string | null }) => {
      due = dueAt;
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  await flush();
  const review = screen.getByRole("button", {
    name: /T-KQ1.*First.*waiting for you/,
  });
  review.focus();
  fireEvent.keyDown(review, { key: "j" });
  await flush();
  const card = screen.getByRole("region", { name: "Inbox triage" });
  expect(
    within(card).getByRole("button", { name: /Move to Done/ }),
  ).toBeTruthy();
  expect(screen.getByText("1 of 2")).toBeTruthy();
  const order = () =>
    [...document.querySelectorAll(".inbox-ticket")].map(
      (row) => row.textContent,
    );
  const before = order();
  fireEvent.keyDown(review, { key: "Enter", ctrlKey: true });
  await flush();
  expect(first.status).toBe("Done");
  expect(order()).toEqual(before);
  expect(review.closest("section")?.querySelector("h2")?.textContent).toContain(
    "Needs you",
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(first.status).toBe("In review");
  fireEvent.click(review);
  await flush();
  fireEvent.keyDown(review, { key: "e" });
  await flush();
  expect(entries[0]?.read).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(entries[0]?.read).toBe(true);
  fireEvent.keyDown(review, { key: "r" });
  await flush();
  const update = screen.getByRole("textbox", { name: "New update rich text" });
  expect(update.textContent || (update as HTMLTextAreaElement).value).toContain(
    "Re:",
  );
  expect(update.textContent || (update as HTMLTextAreaElement).value).toContain(
    "codex",
  );
  fireEvent.keyDown(update, { key: "h" });
  expect(screen.queryByRole("menu")).toBeNull();
  review.focus();
  fireEvent.keyDown(review, { key: "j" });
  await flush();
  expect(screen.getByText("2 of 2")).toBeTruthy();
  fireEvent.keyDown(review, { key: "h" });
  await flush();
  fireEvent.click(screen.getByRole("menuitem", { name: /In 1 hour/ }));
  await flush();
  expect(due).not.toBe("2020-01-01T00:00:00Z");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(due).toBe("2020-01-01T00:00:00Z");
});

test.each([
  ["1", "title"],
  ["2", "title"],
  ["3", "title"],
  ["1", "choice"],
  ["1", "retry"],
  ["1", "multiple"],
  ["1", "typing"],
] as const)(
  "Inbox approval %s from %s keeps keyboard triage through the next review",
  async (choice, mode) => {
    const user = userEvent.setup();
    const { ChatClientContext } = await import("@/features/chats/client");
    const { createMockChatClient, chatState } =
      await import("@/features/chats/mock-client");
    let ticket = bulkTicket(1, { status: "In review" });
    const review = {
      id: 301,
      reference: "T-KQ1",
      title: "First",
      kind: "status",
      from_value: "In progress",
      to_value: "In review",
      timestamp: "2026-11-16T00:00:00Z",
      editing_agent: "codex",
      read: true,
    };
    const chats = createMockChatClient({
      enabled: true,
      chats: [
        {
          chat: chatState({
            id: "triage-chat",
            title: "Triage Chat",
            activity: "idle",
            links: [
              {
                kind: "ticket",
                id: "1",
                reference: "T-KQ1",
                title: "First",
                status: "Todo",
              },
            ],
          }),
        },
      ],
    });
    let releaseContext = () => {};
    const loadingContext = new Promise<null>((resolve) => {
      releaseContext = () => resolve(null);
    });
    bridge.invoke.mockImplementation(
      (
        command: string,
        args?: { reference?: string; patch?: { status?: string } },
      ) => {
        if (command === "find_tickets") return [ticket];
        if (command === "show_ticket") return ticket;
        if (command === "latest_update") return loadingContext;
        if (command === "change_ticket") {
          ticket = { ...ticket, status: args?.patch?.status ?? ticket.status };
          return ticket;
        }
        if (command === "ticket_history") return [review];
        if (command === "inbox") return [review];
        return bridgeDefault(command, args);
      },
    );
    render(
      <ChatClientContext value={chats}>
        <App />
      </ChatClientContext>,
    );
    act(() =>
      chats.push("triage-chat", {
        kind: "request",
        id: "triage-request",
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
    fireEvent.click(await screen.findByRole("button", { name: /^Inbox/ }));
    const approval = await screen.findByRole("button", {
      name: /Approval needed in.*Triage Chat/,
    });
    fireEvent.click(approval);
    expect(
      await screen.findByRole("region", { name: "Inbox triage" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Triage Chat" })).toBeNull();
    // The approval stays actionable while the linked Ticket waits for its agent context.
    expect(
      await screen.findByRole("status", {
        name: "Loading ticket agent context",
      }),
    ).toBeTruthy();
    const queue = document.querySelector(".inbox");
    approval.focus();
    await user.keyboard("{Enter}");
    const heading = await screen.findByRole("heading", { name: "Triage Chat" });
    expect(heading.closest("#detail")).toBeTruthy();
    act(() => releaseContext());
    expect(document.querySelector(".inbox")).toBe(queue);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
    const answerChat = chats.answer.bind(chats);
    const answer = vi.spyOn(chats, "answer");
    const requestTitle = await screen.findByRole("heading", {
      name: "wants to run",
    });
    expect(document.activeElement).toBe(requestTitle);
    for (const [index, label] of [
      "Allow once",
      "Allow for this session",
      "Decline",
    ].entries()) {
      const option = screen.getByRole("button", { name: label });
      expect(option.getAttribute("aria-keyshortcuts")).toBe(String(index + 1));
      expect(option.querySelector("kbd")?.textContent).toBe(String(index + 1));
      expect(option.querySelector("kbd")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
    }
    if (mode === "multiple")
      act(() =>
        chats.push("triage-chat", {
          kind: "request",
          id: "second-request",
          at: "2026-11-16T00:00:01Z",
          request: "approval",
          title: "wants another command",
          command: "npm run build",
          options: [{ id: "build", label: "Allow build" }],
          state: "pending",
          free_text: false,
        }),
      );
    if (mode === "retry")
      answer.mockRejectedValueOnce(new Error("Disconnected"));
    let releaseAnswer = () => {};
    if (mode === "typing") {
      const waiting = new Promise<void>((resolve) => {
        releaseAnswer = resolve;
      });
      answer.mockImplementationOnce(async (...args) => {
        await waiting;
        await answerChat(...args);
      });
    }
    if (mode === "choice")
      await user.click(screen.getByRole("button", { name: "Allow once" }));
    else await user.keyboard(choice);
    if (mode === "retry") {
      expect(await screen.findByText(/Pick again to retry/)).toBeTruthy();
      expect(document.activeElement).toBe(requestTitle);
      const failure = screen.getByRole("alert");
      expect(within(failure).getByText("Answer not sent")).toBeTruthy();
      expect(screen.getByText("npm test -- board")).toBeTruthy();
      const details = within(failure).getByRole("button", { name: "Details" });
      await user.click(details);
      const popup = await screen.findByRole("dialog", {
        name: "Failure details",
      });
      expect(within(popup).getByText(/Disconnected/)).toBeTruthy();
      await user.keyboard("{Escape}");
      expect(
        screen.queryByRole("dialog", { name: "Failure details" }),
      ).toBeNull();
      expect(document.activeElement).toBe(details);
      act(() => requestTitle.focus());
      expect(
        approval.closest(".inbox-entry")?.getAttribute("aria-current"),
      ).toBe("true");
      expect(screen.getByRole("heading", { name: "Triage Chat" })).toBeTruthy();
      expect((await chats.openChat("triage-chat")).items).toContainEqual(
        expect.objectContaining({ id: "triage-request", state: "pending" }),
      );
      await user.keyboard(choice);
    }
    if (mode === "typing") {
      const composer = screen.getByRole("textbox", { name: /Codex/ });
      act(() => composer.focus());
      await user.keyboard("1j");
      act(() => releaseAnswer());
      await vi.waitFor(() =>
        expect(
          screen.queryByRole("group", { name: "wants to run" }),
        ).toBeNull(),
      );
      expect(document.activeElement).toBe(composer);
      expect(composer).toHaveProperty("value", "1j");
      act(() =>
        chats.push("triage-chat", {
          kind: "response",
          id: "external-update",
          at: "2026-11-16T00:01:00Z",
          text: "Host update",
          state: "complete",
        }),
      );
      expect(await screen.findByText("Host update")).toBeTruthy();
      expect(document.activeElement).toBe(composer);
      expect(composer).toHaveProperty("value", "1j");
      expect(document.querySelector(".inbox")).toBe(queue);
      return;
    }
    if (mode === "multiple") {
      const nextRequest = await screen.findByRole("heading", {
        name: "wants another command",
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(nextRequest));
      expect(screen.getByRole("heading", { name: "Triage Chat" })).toBeTruthy();
      await user.keyboard("1");
      await vi.waitFor(() =>
        expect(answer).toHaveBeenCalledWith("triage-chat", "second-request", {
          option_id: "build",
        }),
      );
    }
    await vi.waitFor(() =>
      expect(answer).toHaveBeenCalledWith("triage-chat", "triage-request", {
        option_id:
          choice === "1" ? "allow" : choice === "2" ? "session" : "deny",
      }),
    );
    const label =
      choice === "1"
        ? "Allow once"
        : choice === "2"
          ? "Allow for this session"
          : "Decline";
    expect(screen.queryByRole("group", { name: "wants to run" })).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Chats, 1 working" }),
    ).toBeTruthy();
    expect((await chats.openChat("triage-chat")).items).toContainEqual(
      expect.objectContaining({
        id: "triage-request",
        state: "answered",
        outcome: `You chose "${label}"`,
      }),
    );
    expect(
      screen.getByRole("button", { name: /Approval needed in.*Triage Chat/ }),
    ).toBe(approval);
    act(() =>
      chats.push("triage-chat", {
        kind: "response",
        id: "triage-response",
        at: "2026-11-16T00:01:00Z",
        text: "The board checks passed.",
        state: "complete",
      }),
    );
    expect(await screen.findByText("The board checks passed.")).toBeTruthy();
    expect(document.activeElement).toBe(approval);
    await user.keyboard("j");
    const next = await screen.findByRole("region", { name: "Inbox triage" });
    expect(
      within(next).getByRole("button", { name: /Move to Done/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Triage Chat" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Approval needed in.*Triage Chat/ }),
    ).toBeNull();
    expect(document.querySelector(".inbox")).toBe(queue);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Moved T-KQ1 to Done")).toBeTruthy();
    expect(ticket.status).toBe("Done");
    expect(document.querySelector(".inbox")).toBe(queue);
  },
);

test("Inbox triage reports accepting a review as one write", async () => {
  let first = bulkTicket(1, { status: "In review" });
  const timestamp = "2026-11-15T00:00:00Z";
  const entries = [
    {
      id: 201,
      reference: "T-KQ1",
      title: "First",
      kind: "status",
      from_value: "In progress",
      to_value: "In review",
      timestamp,
      editing_agent: "codex",
      read: false,
    },
  ];
  await renderBulk({
    attachment_workspace_id: () => "triage-test",
    latest_update: () => null,
    is_following: () => false,
    find_tickets: () => [first],
    show_ticket: () => first,
    ticket_history: () => [
      {
        kind: "status",
        from_value: "In progress",
        to_value: first.status,
        timestamp,
        editing_agent: "codex",
      },
    ],
    reminder: () => null,
    inbox: () => entries,
    change_ticket: ({ patch }: { patch: { status: string } }) => {
      first = { ...first, status: patch.status };
      return first;
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  await flush();
  const review = screen.getByRole("button", {
    name: /T-KQ1.*First.*waiting for you/,
  });
  review.focus();
  fireEvent.keyDown(review, { key: "j" });
  await flush();
  // Each write report reads the change token once.
  const before = tokenCalls;
  fireEvent.keyDown(review, { key: "Enter", ctrlKey: true });
  await flush();
  await flush();
  expect(first.status).toBe("Done");
  expect(tokenCalls - before).toBe(1);
});

test.each([true, false])(
  "Inbox triage says a deleted Ticket no longer exists instead of loading for good (still listed: %s)",
  async (stillListed) => {
    const first = bulkTicket(1, { status: "In review" });
    const timestamp = "2026-11-15T00:00:00Z";
    let gone = false;
    await renderBulk({
      attachment_workspace_id: () => "triage-gone",
      latest_update: () => null,
      is_following: () => false,
      find_tickets: () => (gone && !stillListed ? [] : [first]),
      show_ticket: () => {
        if (gone) throw { code: "not_found", message: "T-KQ1 was not found" };
        return first;
      },
      ticket_history: () => [
        {
          kind: "status",
          from_value: "In progress",
          to_value: "In review",
          timestamp,
          editing_agent: "codex",
        },
      ],
      reminder: () => null,
      inbox: () => [
        {
          id: 301,
          reference: "T-KQ1",
          title: "First",
          kind: "status",
          from_value: "In progress",
          to_value: "In review",
          timestamp,
          editing_agent: "codex",
          read: false,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    const flush = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    await flush();
    const review = screen.getByRole("button", {
      name: /T-KQ1.*First.*waiting for you/,
    });
    review.focus();
    fireEvent.keyDown(review, { key: "j" });
    await flush();
    const card = screen.getByRole("region", { name: "Inbox triage" });
    // Deleted elsewhere; the next change reads it as gone.
    gone = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await flush();
    expect(within(card).getByText("The Ticket no longer exists.")).toBeTruthy();
    expect(within(card).queryByText("The Ticket is still loading.")).toBeNull();
    // Nothing waits on the Ticket any more, so no placeholder stays.
    expect(card.querySelector('[data-slot="skeleton"]')).toBeNull();
  },
);

test("Inbox Retry preserves its operation identity and Undo restores Needs you after reload until a genuine later review", async () => {
  vi.useFakeTimers();
  let first = bulkTicket(1, { status: "In review" });
  const second = bulkTicket(2);
  const original = {
    kind: "status",
    from_value: "In progress",
    to_value: "In review",
    timestamp: "2020-01-01T00:00:00Z",
    editing_agent: "codex",
  };
  let transition = original;
  let entries = [
    { ...original, id: 401, reference: "T-KQ1", title: "First", read: false },
    {
      id: 402,
      reference: "T-KQ2",
      title: "Second",
      read: true,
      kind: "status",
      from_value: "update-second",
      to_value: "Done",
      timestamp: "2020-01-01T00:00:00Z",
      editing_agent: "codex",
    },
  ];
  const accepted = new Set<string>();
  let lostReply = true;
  bridge.invoke.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      if (command === "find_tickets") return [first, second];
      if (command === "show_ticket")
        return args?.reference === "T-KQ1" ? first : second;
      if (command === "ticket_history")
        return args?.reference === "T-KQ1" ? [transition] : [];
      if (command === "inbox") return entries;
      if (command === "set_inbox_read") {
        const ids = args?.ids as number[];
        entries = entries.map((entry) =>
          ids.includes(entry.id)
            ? { ...entry, read: args?.read as boolean }
            : entry,
        );
        return;
      }
      if (command === "change_ticket") {
        const id = args?.requestId as string;
        if (!accepted.has(id)) {
          accepted.add(id);
          const status = (args?.patch as { status: string }).status;
          transition = {
            kind: "status",
            from_value: first.status,
            to_value: status,
            timestamp: `2026-11-16T00:0${accepted.size}:00Z`,
            editing_agent: "local-person",
          };
          first = { ...first, status };
        }
        if (lostReply) {
          lostReply = false;
          throw new Error("The connection closed before its reply arrived.");
        }
        return first;
      }
      return bridgeDefault(command, args);
    },
  );
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  render(<App />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  await flush();
  const row = screen.getByRole("button", { name: /T-KQ1.*waiting for you/ });
  fireEvent.click(row);
  await flush();
  fireEvent.keyDown(row, { key: "Enter", ctrlKey: true });
  await flush();
  expect(first.status).toBe("Done");
  const failure = screen.getByRole("button", { name: "Retry" });
  entries = [
    {
      ...entries[1]!,
      id: 403,
      reference: "T-KQ3",
      title: "Live Ticket",
      kind: "status",
      to_value: "In progress",
      timestamp: "2026-11-16T00:00:00Z",
      read: false,
    },
    ...entries,
  ];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(
    screen.queryByRole("button", { name: /T-KQ3.*Live Ticket/ }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBe(failure);
  expect(row.closest("section")?.textContent).toContain("Needs you");
  fireEvent.click(failure);
  await flush();
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "change_ticket",
  );
  expect((writes[0]?.[1] as { requestId: string }).requestId).toBe(
    (writes[1]?.[1] as { requestId: string }).requestId,
  );
  expect(accepted.size).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(first.status).toBe("In review");
  expect(transition.editing_agent).toBe("local-person");
  expect(
    screen.getByRole("button", { name: "Inbox, 1 entry needs you" }),
  ).toBeTruthy();
  fireEvent.keyDown(row, { key: "j" });
  await flush();
  expect(
    screen
      .getByRole("button", { name: /T-KQ1.*waiting for you/ })
      .closest("section")?.textContent,
  ).toContain("Needs you");
  expect(
    screen.getByRole("button", { name: /T-KQ3.*Live Ticket/ }),
  ).toBeTruthy();
  cleanup();
  render(<App />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  await flush();
  expect(
    screen
      .getByRole("button", { name: /T-KQ1.*waiting for you/ })
      .closest("section")?.textContent,
  ).toContain("Needs you");
  transition = {
    ...transition,
    from_value: "Done",
    timestamp: "2026-11-16T01:00:00Z",
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByText("You're all caught up")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Inbox, 1 entry needs you" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: /T-KQ2.*Second/ })).toBeTruthy();
});

test("Undo of a review with no agent reports the restored status at once and never says it failed", async () => {
  vi.useFakeTimers();
  let first = bulkTicket(1, { status: "In review" });
  const second = bulkTicket(2);
  let transition = {
    kind: "status",
    from_value: "In progress",
    to_value: "In review",
    timestamp: "2020-01-01T00:00:00Z",
    // A status change from the CLI without `--agent`.
    editing_agent: null as string | null,
  };
  const entries = [
    { ...transition, id: 401, reference: "T-KQ1", title: "First", read: false },
  ];
  bridge.invoke.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      if (command === "find_tickets") return [first, second];
      if (command === "show_ticket")
        return args?.reference === "T-KQ1" ? first : second;
      if (command === "ticket_history")
        return args?.reference === "T-KQ1" ? [transition] : [];
      if (command === "inbox") return entries;
      if (command === "set_inbox_read") return;
      if (command === "change_ticket") {
        const status = (args?.patch as { status: string }).status;
        transition = {
          kind: "status",
          from_value: first.status,
          to_value: status,
          timestamp: "2026-11-16T00:00:00Z",
          editing_agent: null,
        };
        first = { ...first, status };
        return first;
      }
      return bridgeDefault(command, args);
    },
  );
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  render(<App />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  await flush();
  const row = screen.getByRole("button", { name: /T-KQ1.*First/ });
  fireEvent.click(row);
  await flush();
  const moveToDone = () =>
    within(screen.getByRole("region", { name: "Inbox triage" })).getByRole(
      "button",
      { name: /Move to Done/ },
    ) as HTMLButtonElement;
  fireEvent.keyDown(row, { key: "Enter", ctrlKey: true });
  await flush();
  expect(first.status).toBe("Done");
  expect(moveToDone().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(first.status).toBe("In review");
  // The card shows the restored status without waiting for the next poll.
  expect(moveToDone().disabled).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("Inbox unlinked approvals keep Chat review available and mark all read sends only real Inbox IDs", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient, chatState } =
    await import("@/features/chats/mock-client");
  const chats = createMockChatClient({
    enabled: true,
    chats: [
      {
        chat: chatState({
          id: "unlinked-approval",
          title: "Unlinked approval",
          activity: "idle",
          links: [],
        }),
      },
    ],
  });
  let read = false;
  bridge.invoke.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      if (command === "inbox")
        return [
          {
            id: 501,
            reference: "T-KQ1",
            title: "First",
            kind: "activity",
            from_value: "activity",
            to_value: "A new update",
            timestamp: "2026-11-16T00:00:00Z",
            editing_agent: "codex",
            read,
          },
        ];
      if (command === "set_inbox_read") {
        read = args?.read as boolean;
        return;
      }
      return bridgeDefault(command, args);
    },
  );
  render(
    <ChatClientContext value={chats}>
      <App />
    </ChatClientContext>,
  );
  act(() =>
    chats.push("unlinked-approval", {
      kind: "request",
      id: "request",
      at: "2026-11-16T00:00:00Z",
      request: "approval",
      title: "wants to run",
      command: "npm test",
      options: [{ id: "allow", label: "Allow once" }],
      state: "pending",
      free_text: false,
    }),
  );
  await chats.markUnread("unlinked-approval");
  fireEvent.click(await screen.findByRole("button", { name: /^Inbox/ }));
  const approval = await screen.findByRole("button", {
    name: /Approval needed in.*Unlinked approval/,
  });
  fireEvent.click(approval);
  const card = await screen.findByRole("region", { name: "Inbox triage" });
  expect(
    within(card).getByText("This Chat has no linked Ticket."),
  ).toBeTruthy();
  expect(
    (within(card).getByRole("button", { name: /Reply/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      within(card).getByRole("button", {
        name: /Remind me/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  act(() =>
    reportWorkspaceFailure(
      "workspace_read_only",
      "The workspace is read-only.",
    ),
  );
  expect(
    (
      within(card).getByRole("button", {
        name: /Mark read/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      within(card).getByRole("button", {
        name: /Review in Chat/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  act(() => clearWorkspaceFailure());
  const chatRead = vi.spyOn(chats, "markRead");
  fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  await vi.waitFor(() => expect(read).toBe(true));
  await vi.waitFor(() =>
    expect(chatRead).toHaveBeenCalledWith("unlinked-approval"),
  );
  const calls = bridge.invoke.mock.calls.filter(
    ([command]) => command === "set_inbox_read",
  );
  expect(calls.map(([, args]) => (args as { ids: number[] }).ids)).toEqual([
    [501],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await vi.waitFor(() => expect(read).toBe(false));
  fireEvent.keyDown(approval, { key: "Enter" });
  expect(
    await screen.findByRole("heading", { name: "Unlinked approval" }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
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

test("Agent skills keeps installed rows and local recovery through a failed refresh", async () => {
  const user = userEvent.setup();
  let fail = false;
  let reads = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "agent_skills") {
        if (++reads > 12) throw new Error("Agent skill checks did not settle");
        if (fail) throw new Error("Synthetic cached refresh failure");
        return [
          {
            id: "codex",
            name: "Codex",
            path: "/fake/skills",
            detected: true,
            state: "installed",
            error: null,
          },
        ];
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  const nav = within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  );
  await user.click(nav.getByRole("button", { name: /^Agent skills/ }));
  const skill = screen.getByRole("region", { name: "ticketd skill" });
  const agents = screen.getByRole("region", {
    name: "Agents on this computer",
  });
  await within(skill).findByText("Installed");
  const codex = within(agents).getByRole("listitem");
  const check = within(agents).getByRole("button", { name: "Check again" });
  const settled = reads;
  fail = true;
  await user.click(check);
  const failure = await within(skill).findByRole("alert");
  expect(within(failure).getByText("Refresh failed")).toBeTruthy();
  expect(within(skill).getByText("Installed")).toBeTruthy();
  expect(within(agents).getByRole("listitem")).toBe(codex);
  expect(within(codex).getByText("Installed")).toBeTruthy();
  expect(reads).toBe(settled + 1);
  const details = within(failure).getByRole("button", { name: "Details" });
  await user.click(details);
  const popup = await screen.findByRole("dialog", { name: "Failure details" });
  expect(
    within(popup).getByText(/Synthetic cached refresh failure/),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Failure details" })).toBeNull();
  expect(document.activeElement).toBe(details);
  expect(within(agents).getByRole("button", { name: "Check again" })).toBe(
    check,
  );
  fail = false;
  await user.click(within(failure).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(within(skill).queryByRole("alert")).toBeNull());
  expect(within(skill).getByText("Installed")).toBeTruthy();
  expect(within(agents).getByRole("listitem")).toBe(codex);
  expect(reads).toBeLessThanOrEqual(settled + 3);
  expect(
    within(nav.getByRole("button", { name: /^Agent skills/ })).queryByRole(
      "img",
      { name: "Needs setup" },
    ),
  ).toBeNull();
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

test("New ticket expands without replacing the rich draft and creates once from a focused property", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  const created = bulkTicket(16, { title: "Keep every keystroke" });
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "create_ticket") return created;
    return bridgeDefault(command);
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await openNewTicket();
  const title = screen.getByRole("textbox", { name: "Title" });
  expect(document.activeElement).toBe(title);
  fireEvent.change(title, { target: { value: "Keep every keystroke" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.getByRole("textbox", { name: "Description rich text" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Description source" }),
    {
      target: {
        value:
          "# Exact draft\n\n- [ ] Keep **this**\n\n```mermaid\ngraph LR; A-->B\n```",
      },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  const beforeExpand = screen.getByRole("textbox", {
    name: "Description rich text",
  });
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "New ticket" }))
      .getAllByRole("button", { name: "Expand" })
      .at(-1)!,
  );
  expect(screen.getByRole("textbox", { name: "Description rich text" })).toBe(
    beforeExpand,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Create more" }));
  const status = screen.getByRole("button", { name: "Status: Todo" });
  status.focus();
  fireEvent.keyDown(status, { key: "Enter", ctrlKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "create_ticket",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]?.[1]).toMatchObject({
    title: "Keep every keystroke",
    body: expect.stringContaining("A-->B"),
  });
  expect(screen.queryByRole("listbox", { name: "Status choices" })).toBeNull();
  expect(screen.getByText("Created T-KQ16.")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Title" }),
  );
});

test("Capture saves a linked Document without changing the thought and keeps it in Documents", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  const ticket = bulkTicket(1);
  let documentBody: string | null = null;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { body?: string }) => {
      if (command === "find_tickets") return [ticket];
      if (command === "show_ticket") return ticket;
      if (command === "save_document") {
        documentBody = args?.body ?? "";
        return {
          id: "capture-1",
          title: "Drag idea",
          body: documentBody,
          created_at: "2026-11-16",
          updated_at: "2026-11-16",
          trashed: false,
        };
      }
      if (command === "recent_documents" && documentBody !== null)
        return [{ id: "capture-1", heading: "Drag idea" }];
      return bridgeDefault(command);
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
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const card = within(screen.getByRole("dialog", { name: "New Document" }));
  expect(card.getByText("Linked to")).toBeTruthy();
  expect(card.getByText("T-KQ1")).toBeTruthy();
  expect(card.getByText("Kept in Documents")).toBeTruthy();
  fireEvent.change(card.getByRole("textbox", { name: "Title" }), {
    target: { value: "Drag idea" },
  });
  fireEvent.click(card.getByRole("button", { name: "Edit Markdown source" }));
  fireEvent.change(card.getByRole("textbox", { name: "Your thought source" }), {
    target: { value: "Reserve column height." },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(documentBody).toBe(
    "Reserve column height.\n\n[T-KQ1](ticketd://ticket/T-KQ1)",
  );
  expect(
    card.getByRole("textbox", { name: "Your thought source" }),
  ).toHaveProperty("value", "Reserve column height.");
  expect(card.getByText("Saved")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Close" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.getAllByRole("button", { name: /Drag idea/ }).length,
  ).toBeGreaterThan(0);
});

test("read-only Capture keeps an exact text draft across restart and retries the original save", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  let writable = false;
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { draft?: { revision: number }; body?: string },
    ) => {
      if (command === "draft_retentions") return [];
      if (command === "draft_cutover_pending") return false;
      if (command === "retain_draft") {
        if (!writable)
          throw { code: "workspace_read_only", message: "read-only" };
        return { ...args?.draft, revision: (args?.draft?.revision ?? 0) + 1 };
      }
      if (command === "save_document")
        return {
          id: "recovered-capture",
          title: null,
          body: args?.body ?? "",
          created_at: "2026-11-16",
          updated_at: "2026-11-16",
          trashed: false,
        };
      return bridgeDefault(command);
    },
  );
  const first = render(
    <DraftRecoveryProvider>
      <App />
    </DraftRecoveryProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const exact = "# Retry policy\n\n- [ ] Keep **all** keystrokes\n";
  fireEvent.change(
    screen.getByRole("textbox", { name: "Your thought source" }),
    { target: { value: exact } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  fireEvent.click(screen.getByRole("button", { name: "Close and keep draft" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole("dialog", { name: "New Document" })).toBeNull();
  first.unmount();
  clearWorkspaceFailure();
  render(
    <DraftRecoveryProvider>
      <App />
    </DraftRecoveryProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Your thought source" }),
  ).toHaveProperty("value", exact);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  writable = true;
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "New Document" })).getByRole(
      "button",
      { name: "Retry" },
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("Saved")).toBeTruthy();
  const saves = bridge.invoke.mock.calls.filter(
    ([command]) => command === "save_document",
  );
  expect(saves).toHaveLength(1);
  expect(saves[0]?.[1]).toMatchObject({ body: exact });
  expect(
    localStorage.getItem("ticketd:capture-text-fallback:workspace-test"),
  ).toBeNull();
});

test("Capture refuses browser-only recovery for canonical attachment references", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft")
      throw { code: "workspace_read_only", message: "read-only" };
    return bridgeDefault(command);
  });
  render(
    <DraftRecoveryProvider>
      <App />
    </DraftRecoveryProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const exact =
    "[Trace][file]\n\n[file]: ticketd&#58;//attachment/workspace-test/file-1";
  fireEvent.change(
    screen.getByRole("textbox", { name: "Your thought source" }),
    { target: { value: exact } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  fireEvent.click(screen.getByRole("button", { name: "Close and keep draft" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("dialog", { name: "New Document" })).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Your thought source" }),
  ).toHaveProperty("value", exact);
  expect(
    screen.queryByRole("button", { name: "Close and keep draft" }),
  ).toBeNull();
  expect(
    localStorage.getItem("ticketd:capture-text-fallback:workspace-test"),
  ).toBeNull();
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "save_document"),
  ).toHaveLength(0);
});

test("New ticket blocker search retains its selection and query through failure and Retry", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  const blocker = bulkTicket(1);
  let failed = false;
  bridge.invoke.mockImplementation(async (command: string, args) => {
    if (command === "search_tickets") {
      if (args.query === "missing" && !failed) {
        failed = true;
        throw new Error("Workspace temporarily unavailable");
      }
      return [blocker];
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await openNewTicket();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Kept title" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Blocked by: none" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  fireEvent.click(screen.getByRole("option", { name: /T-KQ1.*First/ }));
  const search = screen.getByPlaceholderText("Search blocked by…");
  fireEvent.change(search, { target: { value: "missing" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(screen.getByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Couldn't search blockers"),
  );
  expect(screen.queryByText("No matches")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Blocked by: T-KQ1" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(/Workspace temporarily unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(search).toHaveProperty("value", "missing");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen
      .getByRole("option", { name: /T-KQ1.*First/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Kept title",
  );
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "create_ticket"),
  ).toHaveLength(0);
});

test("New ticket keeps its draft and retries creation with all blockers atomically", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  const blocker = bulkTicket(1);
  const created = bulkTicket(2, { title: "Dependent" });
  let failCreate = true;
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "search_tickets" || command === "find_tickets")
      return [blocker];
    if (command === "show_ticket") return created;
    if (command === "create_ticket") {
      if (failCreate) {
        failCreate = false;
        throw new Error("Workspace temporarily unavailable");
      }
      return created;
    }
    return bridgeDefault(command);
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await openNewTicket();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Dependent" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Status: Todo" }));
  fireEvent.click(screen.getByRole("option", { name: "In progress" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Blocked by: none" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  fireEvent.click(screen.getByRole("option", { name: /T-KQ1.*First/ }));
  fireEvent.keyDown(
    screen.getByRole("dialog", { name: "Blocked by choices" }),
    { key: "Escape" },
  );
  expect(
    bridge.invoke.mock.calls.filter(([command]) =>
      ["create_ticket", "add_dependency", "change_ticket"].includes(command),
    ),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry safely" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const creates = bridge.invoke.mock.calls.filter(
    ([command]) => command === "create_ticket",
  );
  expect(creates).toHaveLength(2);
  expect(creates[0]?.[1]).toEqual(creates[1]?.[1]);
  expect(creates[0]?.[1]).toMatchObject({
    status: "In progress",
    blockers: ["T-KQ1"],
  });
  const links = bridge.invoke.mock.calls.filter(
    ([command]) => command === "add_dependency",
  );
  expect(links).toHaveLength(0);
  expect(screen.queryByRole("dialog", { name: "New ticket" })).toBeNull();
});

test("Capture keeps its editor open if the browser cannot verify a text draft", async () => {
  await import("@/features/markdown/MarkdownEditor");
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft")
      throw { code: "workspace_read_only", message: "read-only" };
    return bridgeDefault(command);
  });
  render(
    <DraftRecoveryProvider>
      <App />
    </DraftRecoveryProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Your thought source" }),
    { target: { value: "Still here." } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  const store = Storage.prototype.setItem;
  const blocked = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("ticketd:capture-text-fallback:"))
        throw new Error("Browser storage is full");
      store.call(this, key, value);
    });
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Close and keep draft" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("dialog", { name: "New Document" })).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Your thought source" }),
    ).toHaveProperty("value", "Still here.");
    expect(screen.getByRole("button", { name: "Copy text" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Close and keep draft" }),
    ).toBeNull();
  } finally {
    blocked.mockRestore();
  }
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

test("Inbox palette actions share selected-entry read, reminder and Activity handlers", async () => {
  await import("@/features/markdown/MarkdownEditor");
  const ticket = bulkTicket(1);
  const due = "2020-01-01T00:00:00Z";
  let read = false;
  await renderBulk({
    latest_update: () => null,
    find_tickets: () => [ticket],
    show_ticket: () => ticket,
    reminder: () => due,
    inbox: () => [
      {
        id: 601,
        reference: "T-KQ1",
        title: "First",
        kind: "reminder",
        from_value: "",
        to_value: due,
        timestamp: "2026-11-16T00:00:00Z",
        editing_agent: null,
        read,
      },
    ],
    set_inbox_read: ({ read: value }: { read: boolean }) => {
      read = value;
    },
  });
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "i" });
  await flush();
  const row = screen.getByRole("button", {
    name: /T-KQ1.*First.*Your reminder/,
  });
  fireEvent.click(row);
  await flush();
  expect(read).toBe(true);
  async function command(name: string) {
    fireEvent.keyDown(row, { key: "k", ctrlKey: true });
    await flush();
    const palette = screen.getByRole("dialog", { name: "Go anywhere" });
    fireEvent.click(
      within(palette).getByRole("option", { name: new RegExp(name) }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
  }
  await command("Toggle Inbox read state");
  expect(read).toBe(false);
  expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(read).toBe(true);
  await command("Snooze reminder");
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(screen.getByText("Snooze until")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  await command("Reply on this Ticket");
  expect(
    screen.getByRole("textbox", { name: "New update rich text" }).textContent,
  ).toContain("Your reminder is due");
});

test("Inbox loading announces its read without guessing urgency, then retains entries if refreshing fails", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let failRefresh = false;
  const due = "2020-01-01T00:00:00Z";
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "inbox") {
      if (failRefresh) throw new Error("temporary inbox read failure");
      return pending;
    }
    if (command === "reminder") return due;
    return bridgeDefault(command, args);
  });
  vi.useFakeTimers();
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  expect(screen.getByRole("status", { name: "Loading Inbox" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /Needs you/ })).toBeNull();
  expect(screen.queryByText("You're all caught up")).toBeNull();
  await act(async () =>
    finish?.([
      {
        id: 1,
        reference: "T-KQ1",
        title: "Retained reminder",
        kind: "reminder",
        from_value: "",
        to_value: due,
        timestamp: due,
        read: false,
        editing_agent: null,
      },
    ]),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const row = screen.getByRole("button", {
    name: /T-KQ1.*Retained reminder.*Your reminder/,
  });
  expect(screen.getByRole("heading", { name: /Needs you/ })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Loading Inbox" })).toBeNull();
  failRefresh = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByText(/Couldn't load the Inbox/)).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: /T-KQ1.*Retained reminder.*Your reminder/,
    }),
  ).toBe(row);
  expect(screen.queryByText("You're all caught up")).toBeNull();
  expect(screen.queryByRole("status", { name: "Loading Inbox" })).toBeNull();
});

test.each(["Command line", "Agent skills"])(
  "Settings %s keeps its last known setup state when Check again fails",
  async (page) => {
    let fail = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if ((command === "check_cli" || command === "agent_skills") && fail) {
          await waiting;
          throw new Error("Synthetic check failure");
        }
        if (command === "agent_skills")
          return [
            {
              id: "codex",
              name: "Codex",
              path: "/fake/skills",
              detected: true,
              state: "not_installed",
              error: null,
            },
          ];
        return bridgeDefault(command, args);
      },
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).getByRole("button", { name: new RegExp(`^${page}`) }),
    );
    const known =
      page === "Command line"
        ? "Get the ticketd executable"
        : "Install for Codex";
    await screen.findByText(known);
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(screen.getByText(known)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Checking…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => release());
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText(known)).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav).getAllByRole("img", { name: "Needs setup" }).length,
    ).toBeGreaterThan(0);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
    );
  },
);

test("Drive save Retry retains the unsaved interval and repeats its assignment", async () => {
  let settings = syncSettings();
  let fail = true;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "sync_status") return syncStatus();
      if (command === "sync_settings") return settings;
      if (command === "set_sync_settings") {
        if (fail) throw new Error("Synthetic save failure");
        settings = { ...settings, ...(args?.settings as object) };
        return settings;
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("button", { name: "Google Drive" }),
  );
  const interval = await screen.findByRole("textbox", {
    name: "Check for changes every",
  });
  fireEvent.change(interval, { target: { value: "45" } });
  fireEvent.blur(interval);
  expect(await screen.findByText("Not saved")).toBeTruthy();
  expect(interval).toHaveProperty("value", "45");
  expect(settings.poll_interval_secs).toBe(60);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("Saved", { selector: ".sync-field-note" }),
  ).toBeTruthy();
  expect(settings.poll_interval_secs).toBe(45);
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "set_sync_settings",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

test("Chat Retry repeats a failed steer and removes only the refused queued item", async () => {
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient, chatState } =
    await import("@/features/chats/mock-client");
  const client = createMockChatClient({
    enabled: true,
    chats: [
      {
        chat: chatState({
          id: "working-retry",
          title: "Working recovery",
          activity: "working",
          queue: [
            { id: "first", text: "First queued" },
            { id: "second", text: "Second queued" },
          ],
        }),
      },
    ],
  });
  const send = vi
    .spyOn(client, "send")
    .mockRejectedValueOnce(new Error("Synthetic steer failure"));
  const remove = vi
    .spyOn(client, "removeQueued")
    .mockRejectedValueOnce(new Error("Synthetic remove failure"));
  const queue = vi
    .spyOn(client, "queue")
    .mockRejectedValueOnce(new Error("Synthetic queue failure"));
  bridge.invoke.mockImplementation(bridgeDefault);
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Chats" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Working recovery,/ }),
  );
  const input = await screen.findByRole("textbox", { name: "Steer Codex" });
  fireEvent.change(input, { target: { value: "Keep the steer" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  await vi.waitFor(() => expect(input).toHaveProperty("value", ""));
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Retry as Queue" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
  expect(queue.mock.calls[1]).toEqual(queue.mock.calls[0]);
  expect(send).toHaveBeenCalledTimes(2);
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
  );
  await vi.waitFor(() => expect(input).toHaveProperty("value", ""));
  fireEvent.click(
    screen.getAllByRole("button", { name: "Remove from queue" })[0]!,
  );
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.getByText("First queued")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(screen.queryByText("First queued")).toBeNull());
  expect(screen.getByText("Second queued")).toBeTruthy();
  expect(document.activeElement).toBe(input);
  expect(remove.mock.calls).toEqual([
    ["working-retry", "first"],
    ["working-retry", "first"],
  ]);
  send.mockRejectedValueOnce(new Error("Synthetic uncertain submission"));
  fireEvent.change(input, { target: { value: "Keep the uncertain draft" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("button", { name: "Retry" });
  act(() =>
    client.patch("working-retry", {
      problem: { kind: "uncertain_delivery", message_id: "unconfirmed" },
    }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledTimes(3);
  expect(input).toHaveProperty("value", "Keep the uncertain draft");
});

test("Export Retry remembers the failed path and asks the save chooser again before writing", async () => {
  const { workspaceClient } = await import("@/lib/api/workspace");
  const choose = vi
    .spyOn(workspaceClient, "chooseSavePath")
    .mockResolvedValueOnce("/synthetic/export.json")
    .mockResolvedValueOnce(null);
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "export_workspace")
        throw new Error("Synthetic export failure");
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("button", { name: "Export" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(2));
  expect(choose.mock.calls[1]?.[0].defaultPath).toBe("/synthetic/export.json");
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "export_workspace",
    ),
  ).toEqual([["export_workspace", { path: "/synthetic/export.json" }]]);
  choose.mockRestore();
});

test("a delayed Linked read keeps loading feedback until relationships resolve", async () => {
  let resolveRead: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    resolveRead = resolve;
  });
  await renderBulk({
    find_tickets: [bulkTicket(1)],
    show_ticket: bulkTicket(1),
    contextual_relationships: () => pending,
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(
    screen.getByRole("status", { name: "Loading relationships" }),
  ).toBeTruthy();
  expect(screen.queryByText("Couldn't load relationships")).toBeNull();
  await act(async () => {
    resolveRead(bridgeDefault("contextual_relationships"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.queryByRole("status", { name: "Loading relationships" }),
  ).toBeNull();
});

test("unknown relationship failures keep raw text behind Details and structured causes stay actionable", async () => {
  const user = userEvent.setup();
  const current = bulkTicket(1, { title: "Failure privacy outcome" });
  let failure: unknown = new Error("SYNTHETIC_RAW_SECRET");
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets") return [current];
    if (command === "show_ticket") return current;
    if (command === "contextual_relationships") throw failure;
    return bridgeDefault(command);
  });
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /Failure privacy outcome/ }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't load relationships");
  expect(alert.textContent).not.toContain("SYNTHETIC_RAW_SECRET");
  expect(screen.queryByText("SYNTHETIC_RAW_SECRET")).toBeNull();
  await user.click(within(alert).getByRole("button", { name: "Details" }));
  expect(within(alert).getByText(/SYNTHETIC_RAW_SECRET/)).toBeTruthy();
  await user.click(within(alert).getByRole("button", { name: "Details" }));
  failure = { code: "not_found", message: "SYNTHETIC_MISSING_RECORD" };
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("It was deleted or moved.")).toBeTruthy();
  expect(screen.queryByText("SYNTHETIC_MISSING_RECORD")).toBeNull();
  expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
});

test("pointer Delete removes existing evidence directly and Undo restores its fields", async () => {
  const user = userEvent.setup();
  const current = bulkTicket(1, { title: "Pointer evidence outcome" });
  const original = {
    id: "branch-evidence",
    kind: "branch",
    name: "Branch",
    value: "feature/retained",
    editing_agent: "codex",
    created_at: "2026-11-16T00:00:00Z",
    updated_at: "2026-11-16T00:00:00Z",
  };
  let items = [original];
  bridge.invoke.mockImplementation(
    (command: string, args?: { input?: typeof original }) => {
      if (command === "find_tickets") return [current];
      if (command === "show_ticket") return current;
      if (command === "list_evidence") return items;
      if (command === "delete_evidence") {
        items = [];
        return;
      }
      if (command === "add_evidence") {
        const item = { ...original, ...args?.input, id: "restored-branch" };
        items = [item];
        return item;
      }
      return bridgeDefault(command);
    },
  );
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /Pointer evidence outcome/ }),
  );
  // jsdom's zero-sized resize handle sits at (0, 0); use a point outside it.
  await user.pointer({
    target: await screen.findByRole("button", { name: "Actions for Branch" }),
    coords: { clientX: 100, clientY: 100 },
    keys: "[MouseLeft]",
  });
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete" }, { timeout: 1500 }),
  );
  const undo = await screen.findByRole("button", { name: "Undo" });
  expect(
    screen.queryByRole("button", { name: "Actions for Branch" }),
  ).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(undo);
  expect(
    await screen.findByRole("button", { name: "Actions for Branch" }),
  ).toBeTruthy();
  expect(screen.getByText("feature/retained")).toBeTruthy();
  expect(screen.getAllByText(/codex/).length).toBeGreaterThan(0);
});

test("Activity folds recorded changes between authored updates and expands every record in order", async () => {
  const user = userEvent.setup();
  const current = bulkTicket(1, { title: "Folded history outcome" });
  const automatic = (
    id: number,
    kind: string,
    from_value: string,
    to_value: string,
    hour: number,
  ) => ({
    type: "automatic",
    id,
    event: {
      kind,
      from_value,
      to_value,
      timestamp: `2026-11-15T${hour}:00:00Z`,
      editing_agent: "codex",
    },
  });
  const authored = (id: string, brief: string, hour: number) => ({
    type: "authored",
    activity: {
      id,
      ticket_id: current.id,
      brief,
      reported_at: `2026-11-15T${hour}:00:00Z`,
      updated_at: `2026-11-15T${hour}:00:00Z`,
      editing_agent: null,
      supporting_document_id: null,
    },
  });
  const feed = [
    automatic(8, "status", "Todo", "In progress", 18),
    automatic(7, "evidence", "", "Review proof", 17),
    automatic(6, "relationship:related", "", "T-KQ4", 16),
    authored("newer-update", "Latest authored outcome", 15),
    automatic(4, "plan", "", "plan-before-update", 14),
    automatic(3, "dependency", "", "T-KQ3", 13),
    authored("older-update", "Earlier authored outcome", 12),
  ];
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets") return [current];
    if (command === "show_ticket") return current;
    if (command === "activity_feed") return feed;
    return bridgeDefault(command);
  });
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /Folded history outcome/ }),
  );
  const timeline = await screen.findByRole("list", {
    name: "Activity timeline",
  });
  const newer = within(timeline).getByRole("button", { name: /^3 changes:/ });
  const older = within(timeline).getByRole("button", { name: /^2 changes:/ });
  expect(newer.getAttribute("aria-expanded")).toBe("false");
  expect(
    within(timeline).queryByText("Added evidence “Review proof”"),
  ).toBeNull();
  const topLevel = within(timeline)
    .getAllByRole("listitem")
    .map((row) => row.textContent);
  expect(topLevel).toHaveLength(4);
  expect(topLevel[0]).toContain("3 changes:");
  expect(topLevel[1]).toContain("Latest authored outcome");
  expect(topLevel[2]).toContain("2 changes:");
  expect(topLevel[3]).toContain("Earlier authored outcome");
  expect(
    within(
      screen.getAllByRole("article", { name: "Update by you" })[0]!,
    ).getByText("Latest"),
  ).toBeTruthy();
  newer.focus();
  await user.keyboard("{Enter}");
  expect(newer.getAttribute("aria-expanded")).toBe("true");
  expect(within(timeline).getByText("Status Todo → In progress")).toBeTruthy();
  expect(
    within(timeline).getByText("Added evidence “Review proof”"),
  ).toBeTruthy();
  expect(within(timeline).getByText("Linked as related to T-KQ4")).toBeTruthy();
  await user.click(older);
  expect(
    within(timeline).getByText("Plan set to plan-before-update"),
  ).toBeTruthy();
  expect(within(timeline).getByText("Blocked by T-KQ3")).toBeTruthy();
  await user.click(screen.getByRole("radio", { name: "Updates" }));
  expect(
    within(timeline).queryByRole("button", { name: /changes:/ }),
  ).toBeNull();
  expect(within(timeline).getByText("Latest authored outcome")).toBeTruthy();
  expect(within(timeline).getByText("Earlier authored outcome")).toBeTruthy();
});

test("Evidence announces a pending initial read without claiming empty and retains known records on refresh", async () => {
  vi.useFakeTimers();
  const current = bulkTicket(1, { title: "Delayed evidence outcome" });
  const record = {
    id: "delayed-evidence",
    kind: "branch",
    name: "Known branch",
    value: "feature/known",
    editing_agent: null,
    created_at: "2026-11-16T00:00:00Z",
    updated_at: "2026-11-16T00:00:00Z",
  };
  let resolve: (items: (typeof record)[]) => void = () => {};
  const firstRead = new Promise<(typeof record)[]>((done) => {
    resolve = done;
  });
  let initial = true;
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets") return [current];
    if (command === "show_ticket") return current;
    if (command === "list_evidence") return initial ? firstRead : [record];
    return bridgeDefault(command);
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(
    screen.getByRole("button", { name: /Delayed evidence outcome/ }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const evidence = screen.getByRole("region", { name: "Evidence" });
  expect(
    within(evidence).getByRole("status", { name: "Loading evidence" }),
  ).toBeTruthy();
  expect(within(evidence).queryByText("No evidence yet.")).toBeNull();
  await act(async () => {
    initial = false;
    resolve([record]);
  });
  expect(
    within(evidence).getByRole("button", {
      name: "Actions for Known branch",
    }),
  ).toBeTruthy();
  expect(
    within(evidence).queryByRole("status", { name: "Loading evidence" }),
  ).toBeNull();
  // A later read can fail without turning already observed records into loading or empty.
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "find_tickets") return [current];
    if (command === "show_ticket") return current;
    if (command === "list_evidence")
      throw new Error("SYNTHETIC_REFRESH_FAILURE");
    return bridgeDefault(command);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  vi.useRealTimers();
  expect(within(evidence).getByRole("alert")).toBeTruthy();
  expect(
    within(evidence).getByRole("button", { name: "Actions for Known branch" }),
  ).toBeTruthy();
  expect(
    within(evidence).queryByRole("status", { name: "Loading evidence" }),
  ).toBeNull();
});

test("an unknown Plan archive failure keeps raw diagnostics behind Details on the status line", async () => {
  const user = userEvent.setup();
  const plan = {
    id: "private-archive",
    name: "Private archive",
    archived: false,
  };
  bridge.invoke.mockImplementation((command: string, args?: object) => {
    if (command === "list_plans") return [plan];
    if (command === "show_plan") {
      const view = bridgeDefault(command, args) as { plan: object };
      return { ...view, plan };
    }
    if (command === "change_plan") throw new Error("SYNTHETIC_ARCHIVE_RAW");
    return bridgeDefault(command, args);
  });
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Private archive" }),
  );
  const actions = await screen.findByRole("button", { name: "Plan actions" });
  actions.focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Archive Plan" }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't archive Private archive");
  expect(alert.textContent).not.toContain("SYNTHETIC_ARCHIVE_RAW");
  await user.click(within(alert).getByRole("button", { name: "Details" }));
  expect(await screen.findByText("SYNTHETIC_ARCHIVE_RAW")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test.each([
  ["All tickets", "find_tickets"],
  ["Documents", "recent_documents"],
  ["Attachments", "search_attachments"],
] as const)(
  "%s keeps its initial count unknown through failure and recovers to known empty",
  async (name, read) => {
    let rejectRead: ((reason: unknown) => void) | undefined;
    let failed = false;
    const pending = new Promise((_, reject) => {
      rejectRead = reject;
    });
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "workspace_info")
        return { tickets: 14, documents: 0, projects: 0, active_plans: 0 };
      if (command === read && !failed) return pending;
      return bridgeDefault(command, args);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name }));
    const header = screen.getByRole("heading", { name }).closest("header")!;
    expect(header.querySelector('[data-slot="count"]')).toBeNull();
    failed = true;
    await act(async () => rejectRead?.(new Error("initial unavailable")));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(header.querySelector('[data-slot="count"]')).toBeNull();
    fireEvent.click(retry);
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
    );
  },
);

test("Plans initial read stays unknown, retries its own failure and preserves known cards", async () => {
  let rejectRead: ((reason: unknown) => void) | undefined;
  const pending = new Promise((_, reject) => {
    rejectRead = reject;
  });
  let fail = true;
  const plan = {
    id: "read-plan",
    name: "Known Plan",
    archived: false,
    purpose: "Known purpose",
  };
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "list_plans") return fail ? pending : [plan];
    if (command === "show_plan")
      return { plan, counts: counted({}), members: [], documents: [] };
    return bridgeDefault(command, args);
  });
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Search or jump to…" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /^Plans/ }));
  expect(screen.queryByText("No Plans yet")).toBeNull();
  expect(screen.getByRole("status", { name: "Loading Plans" })).toBeTruthy();
  await act(async () => rejectRead?.(new Error("Plans unavailable")));
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByText("No Plans yet")).toBeNull();
  fail = false;
  fireEvent.click(retry);
  expect(
    await screen.findByRole("button", { name: "Open Plan Known Plan" }),
  ).toBeTruthy();
});

test("Workspace graph filters count matching records while retaining structural Plan membership", async () => {
  const user = userEvent.setup();
  const plan = {
    id: "filter-island",
    name: "Filtered island",
    archived: false,
  };
  const tickets = [
    bulkTicket(1, { title: "Unique match", plan_id: plan.id }),
    bulkTicket(2, {
      title: "Second member",
      plan_id: plan.id,
      status: "Done",
      prerequisites: [
        {
          reference: "T-KQ1",
          title: "Unique match",
          status: "Todo",
          trashed: false,
          unresolved: true,
        },
      ],
    }),
  ];
  const doc = {
    id: "filter-doc",
    kind: "document",
    label: "Island spec",
    state: null,
    trashed: false,
    activity_detail: false,
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
    doc,
    ...tickets.map((ticket) => ({
      id: ticket.id,
      kind: "ticket",
      label: `${ticket.reference} · ${ticket.title}`,
      ticket_reference: ticket.reference,
      state: ticket.status,
      trashed: false,
      activity_detail: false,
    })),
  ];
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "find_tickets") return tickets;
      if (command === "show_ticket")
        return tickets.find((t) => t.reference === args.reference);
      if (command === "show_plan")
        return {
          plan,
          counts: counted({ todo: 1, done: 1 }),
          members: tickets,
          documents: [{ id: doc.id, heading: doc.label, trashed: false }],
        };
      if (command === "workspace_graph") {
        const request = args.request as {
          kind: string | null;
          search: string | null;
          relationship: string | null;
          hydrate_only: boolean;
          visible_ids: string[];
        };
        const matches = all.filter(
          (node) =>
            (!request.kind || node.kind === request.kind) &&
            (!request.search || node.label.includes(request.search)),
        );
        const nodes = matches.filter(
          (node) =>
            (!request.hydrate_only || request.visible_ids.includes(node.id)) &&
            (!request.relationship || tickets.some((t) => t.id === node.id)),
        );
        return {
          nodes,
          edges:
            nodes.some((node) => node.id === tickets[0]!.id) &&
            nodes.some((node) => node.id === tickets[1]!.id)
              ? [
                  {
                    source: tickets[0]!.id,
                    target: tickets[1]!.id,
                    kind: "blocks",
                    explanation: null,
                  },
                ]
              : [],
          total: matches.length,
          next_cursor: null,
          omitted: false,
          omitted_groups: [],
          node_tags: {},
        };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Workspace graph" }),
  );
  const graph = screen.getByRole("region", { name: "Workspace graph" });
  await within(graph).findByText("2 tickets, 1 Document");
  await user.click(within(graph).getByRole("button", { name: "Filter" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Type: All" }), {
    key: "Enter",
  });
  await user.click(screen.getByRole("option", { name: "Tickets" }));
  await vi.waitFor(() =>
    expect(within(graph).getByText("2 items · 1 connection")).toBeTruthy(),
  );
  expect(within(graph).getByText("2 tickets, 0 Documents")).toBeTruthy();
  await user.keyboard("{Escape}");
  await user.click(within(graph).getByRole("radio", { name: "List" }));
  expect(within(graph).getByText(/Showing 2 of 2 items/)).toBeTruthy();
  expect(
    graph.querySelectorAll(".cgraph-scroll .cgraph-rows > li"),
  ).toHaveLength(2);
  await user.click(within(graph).getByRole("button", { name: "Filter" }));
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "Unique" },
  });
  await vi.waitFor(() =>
    expect(within(graph).getByText("1 item · 0 connections")).toBeTruthy(),
  );
  expect(within(graph).getByText(/Showing 1 of 1 item/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
  for (const [before, next] of [
    ["Tickets", "Documents"],
    ["Documents", "Plans"],
  ] as const) {
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: `Type: ${before}` }),
      { key: "Enter" },
    );
    await user.click(screen.getByRole("option", { name: next }));
    await vi.waitFor(() =>
      expect(within(graph).getByText("1 item · 0 connections")).toBeTruthy(),
    );
    expect(within(graph).getByText(/Showing 1 of 1 item/)).toBeTruthy();
    expect(
      graph.querySelectorAll(".cgraph-scroll .cgraph-rows > li"),
    ).toHaveLength(1);
  }
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Type: Plans" }), {
    key: "Enter",
  });
  await user.click(screen.getByRole("option", { name: "All" }));
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Relationship: All" }),
    { key: "Enter" },
  );
  await user.click(screen.getByRole("option", { name: "Blocks" }));
  await user.keyboard("{Escape}");
  await user.click(within(graph).getByRole("radio", { name: "Graph" }));
  await within(graph).findByText("2 tickets, 0 Documents");
  expect(within(graph).queryByText(/Not in a Plan/)).toBeNull();
});

test("supporting Document open failure survives an unrelated browse success and retries the intended reader", async () => {
  const current = bulkTicket(1, { title: "Supporting reader outcome" });
  const doc = {
    id: "support-open",
    title: "Supporting context",
    body: "Recovered supporting paragraph",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    trashed: false,
  };
  let rejectOpen: ((reason: unknown) => void) | undefined;
  let finishBrowse: ((value: unknown) => void) | undefined;
  const openRead = new Promise((_, reject) => {
    rejectOpen = reject;
  });
  const browse = new Promise((resolve) => {
    finishBrowse = resolve;
  });
  let retry = false;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "find_tickets") return [current];
    if (command === "show_ticket") return current;
    if (command === "activity_feed")
      return [
        {
          type: "authored",
          activity: {
            id: "support-update",
            ticket_id: current.id,
            brief: "Supporting result",
            reported_at: doc.updated_at,
            updated_at: doc.updated_at,
            editing_agent: null,
            supporting_document_id: doc.id,
          },
        },
      ];
    if (command === "show_document") return doc;
    if (command === "open_document") return retry ? doc : openRead;
    if (command === "recent_documents") return browse;
    if (command === "document_tags") return [];
    if (command === "document_version") return [doc.updated_at, false];
    return bridgeDefault(command, args);
  });
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Supporting reader outcome/ }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open details" }));
  await act(async () => rejectOpen?.(new Error("Open unavailable")));
  await act(async () =>
    finishBrowse?.([{ id: "known-browse", heading: "Known browse record" }]),
  );
  const retryButton = await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByText(/Couldn't open the Document/)).toBeTruthy();
  expect(screen.queryByText(doc.body)).toBeNull();
  retry = true;
  fireEvent.click(retryButton);
  expect(await screen.findByText(doc.body)).toBeTruthy();
  expect(
    bridge.invoke.mock.calls
      .filter(([command]) => command === "open_document")
      .map(([, args]) => args),
  ).toEqual([{ id: doc.id }, { id: doc.id }]);
});

test.each(["All tickets", "Plans", "Documents", "Attachments"] as const)(
  "%s retains known content and counts when a background read fails",
  async (name) => {
    const ticket = bulkTicket(1, { title: "Cached ticket" });
    const plan = { id: "cached-plan", name: "Cached Plan", archived: false };
    const file = {
      id: "cached-file",
      display_name: "cached.txt",
      original_filename: "cached.txt",
      size_bytes: 5,
      kind: "local_snapshot",
      locator: "fixture/cached.txt",
      added_at: "2026-11-01T00:00:00Z",
    };
    let fail = false;
    const read = {
      "All tickets": "find_tickets",
      Plans: "list_plans",
      Documents: "recent_documents",
      Attachments: "search_attachments",
    }[name];
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === read && fail) throw new Error("Cached read unavailable");
      if (command === "workspace_info")
        return { tickets: 1, documents: 1, projects: 0, active_plans: 1 };
      if (command === "find_tickets") return [ticket];
      if (command === "count_tickets")
        return { ...counted({ todo: 1 }), total: 1 };
      if (command === "list_plans") return [plan];
      if (command === "show_plan")
        return { plan, counts: counted({}), members: [], documents: [] };
      if (command === "recent_documents")
        return [{ id: "cached-doc", heading: "Cached Document" }];
      if (command === "search_attachments")
        return [
          {
            attachment: file,
            related: false,
            usage: {
              eligible: false,
              legacy_drafts_pending: false,
              protections: [],
            },
          },
        ];
      return bridgeDefault(command, args);
    });
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name }));
    await act(async () => {});
    const header = screen.getByRole("heading", { name }).closest("header")!;
    expect(header.querySelector('[data-slot="count"]')?.textContent).toMatch(
      /^1/,
    );
    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(header.querySelector('[data-slot="count"]')?.textContent).toMatch(
      /^1/,
    );
    expect(
      screen.getAllByText(
        {
          "All tickets": "Cached ticket",
          Plans: "Cached Plan",
          Documents: "Cached Document",
          Attachments: "cached.txt",
        }[name],
      ).length,
    ).toBeGreaterThan(0);
  },
);

test("Plan Add tickets returns focus to its opener after keyboard dismissal", async () => {
  const user = userEvent.setup();
  const plan = { id: "P-focus", name: "Focus Plan", archived: false };
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "list_plans") return [plan];
    if (command === "show_plan")
      return { plan, counts: counted({}), members: [], documents: [] };
    return bridgeDefault(command, args as undefined);
  });
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /^Focus Plan/ }));
  const add = await screen.findByRole("button", { name: "Add tickets" });
  await user.click(add);
  await screen.findByRole("dialog", { name: "Add tickets to Focus Plan" });
  await user.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await vi.waitFor(() => expect(document.activeElement).toBe(add));
});

test("Activity Delete update transfers menu focus to safe confirmation and retries the same update", async () => {
  const user = userEvent.setup();
  const { finishExit, restore } = dialogAnimationSignals(["popover-content"]);
  try {
    const ticket = bulkTicket(1, { id: "activity-delete-focus" });
    let deleted = false;
    let fail = true;
    const activity = {
      id: "delete-owned",
      ticket_id: ticket.id,
      brief: "Authored outcome to remove",
      reported_at: "2026-11-16T00:00:00Z",
      updated_at: "2026-11-16T00:00:00Z",
      editing_agent: null,
      supporting_document_id: "kept-details",
    };
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "find_tickets") return [ticket];
      if (command === "show_ticket") return ticket;
      if (command === "activity_feed")
        return deleted ? [] : [{ type: "authored", activity }];
      if (command === "show_document")
        return {
          id: "kept-details",
          title: "Kept details",
          body: "Supporting text",
          created_at: activity.reported_at,
          updated_at: activity.updated_at,
          trashed: false,
        };
      if (command === "delete_activity") {
        if (fail) throw new Error("Temporary write unavailable");
        deleted = true;
        return;
      }
      return bridgeDefault(command, args);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /First/ }));
    const actions = await screen.findByRole("button", {
      name: /Actions for update from/,
    });
    actions.focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole(
        "menuitem",
        { name: "Delete update" },
        { timeout: 1500 },
      ),
    );
    let confirm = await screen.findByRole("alertdialog", {
      name: "Delete this update?",
    });
    expect(
      within(confirm).getByText("Its details stay in Documents."),
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirm).getByRole("button", { name: "Cancel" }),
      ),
    );
    await user.keyboard("{Escape}");
    expect(confirm.isConnected).toBe(true);
    finishExit(confirm);
    await vi.waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(actions));
    actions.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{End}{Enter}");
    confirm = await screen.findByRole("alertdialog", {
      name: "Delete this update?",
    });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Write an update…" }));
    await screen.findByRole("textbox", { name: "New update rich text" });
    await user.click(
      screen.getByRole("button", { name: "Edit Markdown source" }),
    );
    const newer = screen.getByRole("textbox", { name: "New update source" });
    fireEvent.change(newer, { target: { value: "Newer retained outcome" } });
    newer.focus();
    finishExit(confirm);
    await user.keyboard("{End}!");
    await vi.waitFor(() => expect(confirm.isConnected).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(newer));
    expect(newer).toHaveProperty("value", "Newer retained outcome!");
    actions.focus();
    await user.keyboard("{Enter}{End}{Enter}");
    confirm = await screen.findByRole("alertdialog", {
      name: "Delete this update?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete update" }),
    );
    expect(
      await within(confirm).findByText(/Couldn't delete the update/),
    ).toBeTruthy();
    expect(screen.getByText(activity.brief)).toBeTruthy();
    fail = false;
    await user.click(
      within(confirm).getByRole("button", { name: "Delete update" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText(activity.brief)).toBeNull(),
    );
    const calls = bridge.invoke.mock.calls.filter(
      ([command]) => command === "delete_activity",
    );
    expect(calls).toHaveLength(2);
    expect(calls.map(([, args]) => args)).toEqual([
      { reference: ticket.reference, id: activity.id },
      { reference: ticket.reference, id: activity.id },
    ]);
  } finally {
    restore();
  }
});

test("Plan multi-add is one retryable atomic request and Undo resumes only unfinished original Plans", async () => {
  const user = userEvent.setup();
  const plan = { id: "P-add", name: "Atomic Plan", archived: false };
  const tickets = [bulkTicket(1), bulkTicket(2, { plan_id: "P-original" })].map(
    (ticket) => ({
      ...ticket,
      title: ticket.title ?? "",
      plan_id: ticket.plan_id as string | null,
    }),
  );
  const requests = new Map<string, unknown>();
  let failAdd = true;
  let loseResponse = true;
  let failUndo = true;
  let loseUndoResponse = true;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "list_plans")
      return [
        plan,
        { id: "P-original", name: "Original Plan", archived: false },
      ];
    if (command === "find_tickets" || command === "search_tickets")
      return tickets;
    if (command === "show_plan")
      return {
        plan,
        counts: counted({
          todo: tickets.filter((t) => t.plan_id === plan.id).length,
        }),
        members: tickets.filter((t) => t.plan_id === plan.id),
        documents: [],
      };
    if (command === "bulk_change") {
      const request = args as {
        references: string[];
        change: { plan_id: string | null };
        requestId: string;
      };
      if (requests.has(request.requestId))
        return requests.get(request.requestId);
      if (
        request.change.plan_id === plan.id &&
        failAdd &&
        request.references.includes("T-KQ2")
      )
        throw new Error("Atomic member validation failed");
      if (request.change.plan_id === "P-original" && failUndo)
        throw new Error("Original Plan temporarily unavailable");
      const selected = tickets.filter((t) =>
        request.references.includes(t.reference),
      );
      for (const ticket of selected) ticket.plan_id = request.change.plan_id;
      const result = selected.map((t) => ({ ...t }));
      requests.set(request.requestId, result);
      if (request.change.plan_id === plan.id && loseResponse) {
        loseResponse = false;
        throw new Error("Committed result response lost");
      }
      if (request.change.plan_id === "P-original" && loseUndoResponse) {
        loseUndoResponse = false;
        throw new Error("Committed Undo result response lost");
      }
      return result;
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /^Atomic Plan/ }));
  await user.click(await screen.findByRole("button", { name: "Add tickets" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Add tickets to Atomic Plan",
  });
  await user.type(within(dialog).getByRole("combobox"), "T-KQ");
  await user.click(
    await within(dialog).findByRole("option", { name: /T-KQ1/ }),
  );
  await user.click(within(dialog).getByRole("option", { name: /T-KQ2/ }));
  await user.click(within(dialog).getByRole("button", { name: "Add tickets" }));
  expect(await within(dialog).findByText(/Couldn't add tickets/)).toBeTruthy();
  expect(tickets.map((t) => t.plan_id)).toEqual([null, "P-original"]);
  expect(
    within(dialog).getByText("2 selected, 1 from another Plan."),
  ).toBeTruthy();
  failAdd = false;
  await user.click(within(dialog).getByRole("button", { name: "Add tickets" }));
  await within(dialog).findByText(/Couldn't add tickets/);
  expect(tickets.map((t) => t.plan_id)).toEqual([plan.id, plan.id]);
  expect(
    screen.getByRole("dialog", { name: "Add tickets to Atomic Plan" }),
  ).toBe(dialog);
  await user.click(within(dialog).getByRole("button", { name: "Retry" }));
  await screen.findByText("Added 2 tickets to Atomic Plan");
  const addCalls = bridge.invoke.mock.calls.filter(
    ([c]) => c === "bulk_change",
  );
  expect(addCalls).toHaveLength(3);
  expect(addCalls[0]?.[1]).toEqual(addCalls[1]?.[1]);
  expect(addCalls[1]?.[1]).toEqual(addCalls[2]?.[1]);
  expect(tickets.map((t) => t.plan_id)).toEqual([plan.id, plan.id]);
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(
    await screen.findByText(/1 of 2 tickets confirmed restored/),
  ).toBeTruthy();
  expect(tickets.map((t) => t.plan_id)).toEqual([null, plan.id]);
  failUndo = false;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(tickets.map((t) => t.plan_id)).toEqual([null, "P-original"]),
  );
  await screen.findByText(/1 of 2 tickets confirmed restored/);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(screen.queryByText(/1 of 2 tickets confirmed restored/)).toBeNull(),
  );
  const undoCalls = bridge.invoke.mock.calls.filter(
    ([c, a]) =>
      c === "bulk_change" &&
      (a as { change: { plan_id: string | null } }).change.plan_id !== plan.id,
  );
  expect(undoCalls).toHaveLength(4);
  expect(undoCalls[1]?.[1]).toEqual(undoCalls[2]?.[1]);
  expect(undoCalls[2]?.[1]).toEqual(undoCalls[3]?.[1]);
  expect(bridge.invoke.mock.calls.some(([c]) => c === "set_plan")).toBe(false);
});

test("Document History and Attachment Cleanup return keyboard focus to their mounted menu triggers", async () => {
  const user = userEvent.setup();
  const doc = {
    id: "history-doc",
    title: "History reader",
    body: "Stable reader paragraph",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    trashed: false,
  };
  const file = {
    id: "cleanup-file",
    display_name: "kept.txt",
    original_filename: "kept.txt",
    size_bytes: 5,
    kind: "local_snapshot",
    locator: "kept",
    added_at: doc.created_at,
  };
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "recent_documents")
      return [{ id: doc.id, heading: doc.title }];
    if (command === "open_document" || command === "show_document") return doc;
    if (
      command === "document_tags" ||
      command === "record_versions" ||
      command === "attachment_cleanup_reviews"
    )
      return [];
    if (command === "document_version") return [doc.updated_at, false];
    if (command === "search_attachments")
      return [
        {
          attachment: file,
          related: false,
          usage: {
            eligible: true,
            protections: [],
            legacy_drafts_pending: false,
          },
        },
      ];
    return bridgeDefault(command, args);
  });
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Documents" }));
  await user.click(await screen.findByRole("button", { name: doc.title }));
  const actions = await screen.findByRole("button", {
    name: "Document actions",
  });
  actions.focus();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "History…" }));
  await screen.findByRole("dialog", { name: "History" });
  await user.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.activeElement).toBe(actions));
  await user.click(screen.getByRole("button", { name: "Attachments" }));
  await screen.findByRole("button", { name: file.display_name });
  const more = screen.getByRole("button", { name: "More library actions" });
  more.focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Clean up unused files…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Clean up unused files",
  });
  await user.click(
    within(dialog).getAllByRole("button", { name: "Close" })[0]!,
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(more));
});

test("Document save failure keeps its draft and offers Retry beside floating edit controls", async () => {
  let stored = {
    id: "save-kept",
    title: "Kept reader",
    body: "Paragraph under edit",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    trashed: false,
  };
  let fail = true;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "recent_documents")
      return [{ id: stored.id, heading: stored.title }];
    if (command === "open_document" || command === "show_document")
      return stored;
    if (command === "document_tags") return [];
    if (command === "document_version") return [stored.updated_at, false];
    if (command === "save_document") {
      if (fail) throw new Error("Save unavailable");
      stored = { ...stored, title: (args as { title: string }).title };
      return stored;
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
  fireEvent.click(await screen.findByRole("button", { name: stored.title }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Retained title draft" } });
  const body = await screen.findByRole("textbox", {
    name: "Document rich text",
  });
  body.focus();
  expect(await screen.findByText(/Couldn't save the Document/)).toBeTruthy();
  expect(title).toHaveProperty("value", "Retained title draft");
  expect(body.textContent).toContain(stored.body);
  expect(document.activeElement).toBe(body);
  const feedback = screen.getByRole("alert");
  expect(feedback.closest(".floating-edit-position")).toBeTruthy();
  fireEvent.click(within(feedback).getByRole("button", { name: "Details" }));
  expect(await screen.findByText("Save unavailable")).toBeTruthy();
  fail = false;
  fireEvent.click(within(feedback).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(screen.queryByText(/Couldn't save the Document/)).toBeNull(),
  );
  await vi.waitFor(() =>
    expect(
      bridge.invoke.mock.calls.filter(([c]) => c === "save_document"),
    ).toHaveLength(2),
  );
  const requests = bridge.invoke.mock.calls.filter(
    ([c]) => c === "save_document",
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]?.[1]).toEqual(requests[1]?.[1]);
});

test("Activity R focuses the single composer and failed posting retains its request and draft for Retry", async () => {
  const ticket = bulkTicket(1);
  let fail = true;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    if (command === "add_activity_with_details") {
      if (fail) throw new Error("Post unavailable");
      return {
        id: "posted",
        ticket_id: ticket.id,
        brief: (args as { brief: string }).brief,
        reported_at: "2026-11-16T00:00:00Z",
        updated_at: "2026-11-16T00:00:00Z",
        editing_agent: null,
      };
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /First/ }));
  await screen.findByRole("button", { name: "File" });
  fireEvent.keyDown(document.body, { key: "r" });
  const editor = await screen.findByRole("textbox", {
    name: "New update rich text",
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor));
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const source = screen.getByRole("textbox", { name: "New update source" });
  fireEvent.change(source, {
    target: { value: "Retry retained authored outcome" },
  });
  fireEvent.keyDown(source, { key: "Enter", ctrlKey: true });
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("Couldn't post the update");
  expect(error.closest(".floating-edit-position")).toBeTruthy();
  expect(source).toHaveProperty("value", "Retry retained authored outcome");
  expect(screen.getAllByRole("button", { name: "Post update" })).toHaveLength(
    1,
  );
  fail = false;
  fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "New update source" }),
    ).toBeNull(),
  );
  const requests = bridge.invoke.mock.calls.filter(
    ([c]) => c === "add_activity_with_details",
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]?.[1]).toEqual(requests[1]?.[1]);
});

test("Attachment Rename keeps the draft and identity through failure, keyboard retry and Escape", async () => {
  const user = userEvent.setup();
  let file = {
    id: "rename-owned",
    display_name: "before.txt",
    original_filename: "before.txt",
    size_bytes: 5,
    kind: "local_snapshot",
    locator: "fixture/before",
    added_at: "2026-11-16T00:00:00Z",
  };
  let fail = true;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "search_attachments")
      return [
        {
          attachment: file,
          related: false,
          usage: {
            eligible: false,
            protections: [],
            legacy_drafts_pending: false,
          },
        },
      ];
    if (command === "attachment_preview")
      return {
        attachment: file,
        status: "unsupported",
        media_type: null,
        message: null,
        can_open: true,
        text_excerpt: { text: "Preview stays here", truncated: false },
        usage: { total: 0, legacy_drafts_pending: false, entries: [] },
      };
    if (command === "rename_attachment") {
      if (fail) throw new Error("Rename unavailable");
      file = {
        ...file,
        display_name: (args as { displayName: string }).displayName,
      };
      return file;
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Attachments" }));
  await user.click(
    await screen.findByRole("button", { name: file.display_name }),
  );
  let more = await screen.findByRole("button", { name: "More actions" });
  more.focus();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
  const input = await screen.findByRole("textbox", { name: "Display name" });
  await user.clear(input);
  await user.type(input, "retained.txt{Enter}");
  expect(await screen.findByText("Not renamed")).toBeTruthy();
  expect(input).toHaveProperty("value", "retained.txt");
  expect(screen.getByText("Preview stays here")).toBeTruthy();
  fail = false;
  input.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("heading", { name: "retained.txt" });
  const writes = bridge.invoke.mock.calls.filter(
    ([c]) => c === "rename_attachment",
  );
  expect(writes).toHaveLength(2);
  expect(writes[0]?.[1]).toEqual(writes[1]?.[1]);
  more = screen.getByRole("button", { name: "More actions" });
  await vi.waitFor(() => expect(document.activeElement).toBe(more));
  more.focus();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Display name" }),
    " abandoned",
  );
  await user.tab();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "Display name" })).toBeNull();
  expect(screen.getByRole("heading", { name: "retained.txt" })).toBeTruthy();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "More actions" }),
    ),
  );
});

test("Ticket description and update draft share one visible floating bar and follow field focus", async () => {
  const ticket = bulkTicket(1, {
    id: "shared-editor-bars",
    body: "Description beside an update draft",
  });
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "find_tickets") return [ticket];
    if (command === "show_ticket") return ticket;
    if (command === "add_activity_with_details")
      throw new Error("Draft post unavailable");
    return bridgeDefault(command, args);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /First/ }));
  await screen.findByRole("button", { name: "File" });
  fireEvent.keyDown(document.body, { key: "r" });
  const update = await screen.findByRole("textbox", {
    name: "New update rich text",
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(update));
  expect(screen.getAllByRole("group", { name: "Edit controls" })).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const source = screen.getByRole("textbox", { name: "New update source" });
  fireEvent.change(source, {
    target: { value: "Retain this failed update draft" },
  });
  fireEvent.keyDown(source, { key: "Enter", ctrlKey: true });
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  fireEvent.click(screen.getByText(ticket.body));
  const description = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  description.focus();
  expect(screen.getAllByRole("group", { name: "Edit controls" })).toHaveLength(
    1,
  );
  expect(screen.getByRole("button", { name: "Done editing" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Post update" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn't post the update",
  );
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  screen.getByRole("textbox", { name: "New update rich text" }).focus();
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Done editing" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Post update" })).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Edit Markdown source" }),
  ).toHaveLength(1);
});

test.each(["tickets", "Documents"])(
  "palette keeps matching results and keyboard recovery when %s lookup fails",
  async (source) => {
    const user = userEvent.setup();
    let failed = true;
    const query = source === "tickets" ? "Settings" : "Docs style guide";
    const doc = {
      id: "style-guide",
      heading: query,
      updated_at: "2026-11-16T00:00:00Z",
    };
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "search_tickets" && source === "tickets" && failed)
        throw new Error("private ticket lookup cause");
      if (command === "search_documents" && source === "Documents" && failed)
        throw new Error("private document lookup cause");
      if (command === "search_tickets" && source === "tickets")
        return [bulkTicket(9, { title: "Settings recovery ticket" })];
      if (command === "recent_documents")
        return source === "Documents" ? [doc] : [];
      if (command === "search_documents")
        return source === "Documents" ? [doc] : [];
      return bridgeDefault(command, args);
    });
    render(<App />);
    await screen.findByRole("button", { name: /^All tickets/ });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    await user.type(input, query);
    const result = await screen.findByRole("option", {
      name: source === "tickets" ? /^Settings/ : new RegExp(query),
    });
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain(
      source === "tickets"
        ? "Couldn't search tickets"
        : "Couldn't search Documents",
    );
    expect(screen.queryByText("No tickets or destinations found.")).toBeNull();
    expect(failure.textContent).not.toContain("private");
    expect(document.activeElement).toBe(input);
    const selected = result.getAttribute("aria-selected");
    const retry = within(failure).getByRole("button", { name: "Retry" });
    retry.focus();
    failed = false;
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(input).toHaveProperty("value", query);
    expect(document.activeElement).toBe(input);
    expect(
      screen
        .getByRole("option", {
          name: source === "tickets" ? /^Settings/ : new RegExp(query),
        })
        .getAttribute("aria-selected"),
    ).toBe(selected);
    expect(screen.getByRole("dialog", { name: "Go anywhere" })).toBeTruthy();
  },
);

test("bulk selection exposes Status, Project, Plan, Tags and More directly", async () => {
  await renderBulk({ find_tickets: () => [bulkTicket(1)] });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select T-KQ1" }));
  const bar = screen.getByRole("region", { name: "Bulk edit" });
  for (const name of [
    "Status of selected tickets",
    "Project of selected tickets",
    "Plan of selected tickets",
    "Tags of selected tickets",
    "More selected ticket actions",
    "Clear selection",
  ])
    expect(within(bar).getByRole("button", { name })).toBeTruthy();
  openMenu("More selected ticket actions");
  expect(screen.getByRole("menuitem", { name: "No project" })).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: "Remove from Plan" }),
  ).toBeTruthy();
});

test("workspace failure defers the band while editing, recovers through its header notice and retains a vacated slot until navigation", async () => {
  const tickets = paletteTickets();
  let locked = true;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "find_tickets") return tickets;
    if (command === "show_ticket") return tickets[1];
    if (command === "change_ticket") {
      if (locked)
        throw { code: "workspace_locked", message: "private lock cause" };
      return { ...tickets[1], ...args.patch };
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Focused Ticket/ }),
  );
  const title = await screen.findByRole("textbox", { name: "Title" });
  const main = screen.getByRole("main");
  fireEvent.pointerEnter(main);
  title.focus();
  fireEvent.change(title, { target: { value: "Keep my draft" } });
  const message =
    "Another ticketd operation is using this workspace. Changes can't be saved right now.";
  const [notice] = await screen.findAllByRole("button", { name: message });
  expect(document.querySelector(".workspace-band-slot")).toBeNull();
  // The disabled field's automatic loss of focus must not commit a reflow.
  fireEvent.focusIn(document.body);
  expect(document.querySelector(".workspace-band-slot")).toBeNull();
  expect(notice).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const paletteInput = await screen.findByRole("combobox", {
    name: "Search tickets and destinations",
  });
  fireEvent.change(paletteInput, { target: { value: "workspace notice" } });
  fireEvent.click(
    await screen.findByRole("option", { name: "Review workspace notice" }),
  );
  const popup = await screen.findByRole("dialog", { name: "Workspace notice" });
  fireEvent.click(within(popup).getByRole("button", { name: "Details" }));
  const details = await screen.findByRole("dialog", {
    name: "Failure details",
  });
  expect(details.textContent).toContain("private lock cause");
  fireEvent.keyDown(details, { key: "Escape" });
  locked = false;
  fireEvent.click(within(popup).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: message })).toBeNull(),
  );
  expect(title).toHaveProperty("value", "Keep my draft");
  expect(screen.getByText(/not saved/i)).toBeTruthy();
  expect(document.querySelector(".workspace-band-slot")).toBeNull();
  // A later failure settles at navigation, then successful Retry clears its wording immediately.
  act(() => reportWorkspaceFailure("workspace_locked", "later lock cause"));
  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  await screen.findByRole("heading", { name: "Documents" });
  const slot = document.querySelector(".workspace-band-slot")!;
  expect(slot.textContent).toContain(message);
  fireEvent.pointerEnter(main);
  const retry = within(slot as HTMLElement).getByRole("button", {
    name: "Retry",
  });
  retry.focus();
  fireEvent.keyDown(retry, { key: "Enter" });
  fireEvent.click(retry);
  await vi.waitFor(() => expect(slot.textContent).toBe(""));
  expect(document.querySelector(".workspace-band-slot")).toBe(slot);
  fireEvent.click(screen.getByRole("button", { name: /^All tickets/ }));
  await vi.waitFor(() =>
    expect(document.querySelector(".workspace-band-slot")).toBeNull(),
  );
});

test("deferred workspace notices share a pending protected Retry across pane headers", async () => {
  const tickets = paletteTickets();
  bridge.invoke.mockImplementation((command: string, args) =>
    command === "find_tickets"
      ? tickets
      : command === "show_ticket"
        ? tickets[1]
        : bridgeDefault(command, args),
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Focused Ticket/ }),
  );
  const title = await screen.findByRole("textbox", { name: "Title" });
  fireEvent.pointerEnter(screen.getByRole("main"));
  title.focus();
  act(() => reportWorkspaceFailure("workspace_read_only", "read-only cause"));
  const label = "This workspace is read-only. Changes can't be saved.";
  const notices = screen.getAllByRole("button", { name: label });
  let finish: ((value: unknown) => void) | undefined;
  let checks = 0;
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "find_tickets") return tickets;
    if (command === "show_ticket") return tickets[1];
    if (command === "sidebar_counts")
      return new Promise((resolve) => {
        checks += 1;
        finish = resolve;
      });
    return bridgeDefault(command, args);
  });
  fireEvent.click(notices[0]!);
  let popup = await screen.findByRole("dialog", { name: "Workspace notice" });
  fireEvent.click(within(popup).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(checks).toBe(1));
  fireEvent.keyDown(popup, { key: "Escape" });
  fireEvent.click(notices[1]!);
  popup = await screen.findByRole("dialog", { name: "Workspace notice" });
  fireEvent.click(within(popup).getByRole("button", { name: "Retry" }));
  await act(async () => {});
  expect(checks).toBe(1);
  await act(async () => finish?.(bridgeDefault("sidebar_counts")));
  expect(screen.queryByRole("button", { name: label })).toBeNull();
  expect(document.querySelector(".workspace-band-slot")).toBeNull();
});

function installNativeZoomBridge() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: (command: string, args: unknown) => bridge.invoke(command, args),
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
    },
  });
  return () => Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

const nativeZoomCalls = () =>
  bridge.invoke.mock.calls.filter(
    ([command]) => command === "plugin:webview|set_webview_zoom",
  );

test.each([
  { platform: "MacIntel", modifiers: { metaKey: true } },
  { platform: "Win32", modifiers: { ctrlKey: true } },
])(
  "page zoom reaches exactly 200% with $platform shortcuts and resets while typing",
  async ({ platform, modifiers }) => {
    const platformStub = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue(platform);
    bridge.invoke.mockImplementation(bridgeDefault);
    render(<App />);
    await screen.findByRole("button", { name: "Settings" });
    // Exercise the real Tauri SDK over the existing fake native IPC boundary.
    const uninstall = installNativeZoomBridge();
    try {
      for (const [index, key] of ["=", "+", "+", "=", "="].entries()) {
        fireEvent.keyDown(document.body, {
          key,
          ...modifiers,
          shiftKey: key === "+" && index === 1,
        });
        await act(async () => {});
      }
      expect(nativeZoomCalls().map(([, args]) => args)).toEqual([
        { label: "main", value: 1.1 },
        { label: "main", value: 1.25 },
        { label: "main", value: 1.5 },
        { label: "main", value: 1.75 },
        { label: "main", value: 2 },
      ]);
      expect(await screen.findByText("Zoom 200%")).toBeTruthy();
      // At the bound, another alias (a plus without Shift) cannot overshoot.
      fireEvent.keyDown(document.body, { key: "+", ...modifiers });
      await act(async () => {});
      expect(nativeZoomCalls()).toHaveLength(5);
      fireEvent.click(sidebarNewTicket());
      const title = await screen.findByRole("textbox", { name: "Title" });
      title.focus();
      fireEvent.keyDown(title, { key: "-", ...modifiers });
      await waitFor(() =>
        expect(bridge.invoke).toHaveBeenCalledWith(
          "plugin:webview|set_webview_zoom",
          { label: "main", value: 1.75 },
        ),
      );
      fireEvent.keyDown(title, { key: "0", ...modifiers });
      expect(await screen.findByText("Zoom 100%")).toBeTruthy();
      expect(document.activeElement).toBe(title);
      for (let step = 0; step < 6; step += 1) {
        fireEvent.keyDown(title, { key: "-", ...modifiers });
        await act(async () => {});
      }
      expect(await screen.findByText("Zoom 50%")).toBeTruthy();
      expect(
        nativeZoomCalls()
          .slice(-4)
          .map(([, args]) => args),
      ).toEqual([
        { label: "main", value: 0.9 },
        { label: "main", value: 0.75 },
        { label: "main", value: 0.67 },
        { label: "main", value: 0.5 },
      ]);
      fireEvent.keyDown(title, { key: "0", ...modifiers });
      expect(await screen.findByText("Zoom 100%")).toBeTruthy();
      const calls = nativeZoomCalls().length;
      fireEvent.keyDown(title, { key: "+" });
      fireEvent.keyDown(title, { key: "=", ...modifiers, isComposing: true });
      fireEvent.keyDown(title, { key: "=", ...modifiers, altKey: true });
      await act(async () => {});
      expect(nativeZoomCalls()).toHaveLength(calls);
    } finally {
      uninstall();
      platformStub.mockRestore();
    }
  },
);

test("page zoom palette actions share keyboard operations, current values and registry hints", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  await screen.findByRole("button", { name: "Settings" });
  const uninstall = installNativeZoomBridge();
  try {
    for (const [label, percent] of [
      ["Zoom in", 110],
      ["Zoom out", 100],
      ["Reset zoom", 100],
    ] as const) {
      if (label === "Reset zoom") {
        fireEvent.keyDown(document.body, { key: "=", ctrlKey: true });
        expect(await screen.findByText("Zoom 110%")).toBeTruthy();
      }
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      const input = await screen.findByRole("combobox", {
        name: "Search tickets and destinations",
      });
      fireEvent.change(input, { target: { value: `> ${label}` } });
      const option = await screen.findByRole("option", {
        name: new RegExp(label),
      });
      expect(option.textContent).toContain(
        label === "Zoom in" ? "100%" : "110%",
      );
      expect(option.getAttribute("aria-keyshortcuts")).toContain("Control+");
      fireEvent.click(option);
      expect(await screen.findByText(`Zoom ${percent}%`)).toBeTruthy();
      expect(bridge.invoke).toHaveBeenCalledWith(
        "plugin:webview|set_webview_zoom",
        { label: "main", value: percent / 100 },
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keyboard shortcuts" }),
    );
    const filter = await screen.findByRole("searchbox", {
      name: "Filter shortcuts",
    });
    fireEvent.change(filter, { target: { value: "zoom" } });
    expect(await screen.findByText("Zoom in")).toBeTruthy();
    expect(screen.getByText("Zoom out")).toBeTruthy();
    expect(screen.getByText("Reset zoom")).toBeTruthy();
  } finally {
    uninstall();
  }
});

test.each([false, true])(
  "page zoom serializes rapid keys and a pending reset wins over stale targets (first fails: %s)",
  async (firstFails) => {
    let finish: (() => void) | undefined;
    bridge.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "plugin:webview|set_webview_zoom" && !finish)
        return new Promise<void>((resolve, reject) => {
          finish = () =>
            firstFails ? reject(new Error("First zoom rejected")) : resolve();
        });
      return bridgeDefault(
        command,
        args as Parameters<typeof bridgeDefault>[1],
      );
    });
    render(<App />);
    await screen.findByRole("button", { name: "Settings" });
    const uninstall = installNativeZoomBridge();
    try {
      for (let step = 0; step < 5; step += 1)
        fireEvent.keyDown(document.body, { key: "=", ctrlKey: true });
      fireEvent.keyDown(document.body, { key: "0", ctrlKey: true });
      expect(nativeZoomCalls().map(([, args]) => args)).toEqual([
        { label: "main", value: 1.1 },
      ]);
      expect(screen.queryByText("Zoom 110%")).toBeNull();
      expect(screen.queryByText("Zoom 200%")).toBeNull();
      await act(async () => finish?.());
      expect(await screen.findByText("Zoom 100%")).toBeTruthy();
      expect(nativeZoomCalls().map(([, args]) => args)).toEqual([
        { label: "main", value: 1.1 },
        { label: "main", value: 1 },
      ]);
    } finally {
      uninstall();
    }
  },
);

test("page zoom keeps the applied value on native failure, exposes raw Details and retries the failed action", async () => {
  const user = userEvent.setup();
  let fail = false;
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "plugin:webview|set_webview_zoom" && fail)
      return Promise.reject(
        new Error("Webview zoom permission rejected: native diagnostic"),
      );
    return bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1]);
  });
  render(<App />);
  await screen.findByRole("button", { name: "Settings" });
  const uninstall = installNativeZoomBridge();
  try {
    fireEvent.keyDown(document.body, { key: "=", ctrlKey: true });
    expect(await screen.findByText("Zoom 110%")).toBeTruthy();
    fail = true;
    fireEvent.keyDown(document.body, { key: "=", ctrlKey: true });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't change zoom. Your previous zoom is kept. Try again.",
    );
    expect(screen.queryByText("Zoom 125%")).toBeNull();
    expect(screen.queryByText(/native diagnostic/)).toBeNull();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.change(input, { target: { value: "> Zoom in" } });
    const option = await screen.findByRole("option", { name: /Zoom in/ });
    expect(option.textContent).toContain("110%");
    // The palette retries the same native action and retains the same prior zoom.
    await user.click(option);
    const failure = await screen.findByRole("alert");
    await user.click(within(failure).getByRole("button", { name: "Details" }));
    expect(
      await screen.findByText(
        "Webview zoom permission rejected: native diagnostic",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Copy details" }),
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText(/native diagnostic/)).toBeNull(),
    );
    expect(screen.getByRole("alert")).toBe(failure);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.activeElement).toBe(
      within(failure).getByRole("button", { name: "Details" }),
    );
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(nativeZoomCalls().map(([, args]) => args)).toEqual([
      { label: "main", value: 1.1 },
      { label: "main", value: 1.25 },
      { label: "main", value: 1.25 },
      { label: "main", value: 1.25 },
    ]);
    expect(await screen.findByText("Zoom 125%")).toBeTruthy();
    screen.getByRole("button", { name: "Dismiss" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Zoom 125%")).toBeNull();
    fireEvent.keyDown(document.body, { key: "0", ctrlKey: true });
    expect(await screen.findByText("Zoom 100%")).toBeTruthy();
  } finally {
    uninstall();
  }
});

test("responsive navigation preserves logical focus when the focused sidebar control disappears", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  const settings = await screen.findByRole("button", { name: "Settings" });
  fireEvent.click(settings);
  fireEvent.click(
    await screen.findByRole("button", { name: "Back to tickets" }),
  );
  const returned = await screen.findByRole("button", { name: "Settings" });
  expect(document.activeElement).toBe(returned);
  act(() => resizeViewport(true));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open navigation" }),
  );
  const search = screen.getByRole("button", { name: "Search" });
  search.focus();
  act(() => resizeViewport(false));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Search or jump to…" }),
  );
  act(() => resizeViewport(true));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Search" }),
  );
});

test("palette Reset zoom restores the visible Search equivalent when native zoom replaces its narrow opener", async () => {
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (
      command === "plugin:window|set_background_color" ||
      command === "plugin:webview|set_webview_background_color"
    )
      return;
    if (command === "plugin:webview|set_webview_zoom") {
      resizeViewport((args as { value: number }).value >= 1.75);
      return;
    }
    return bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1]);
  });
  render(<App />);
  const settings = await screen.findByRole("button", { name: "Settings" });
  settings.focus();
  const uninstall = installNativeZoomBridge();
  try {
    for (let step = 0; step < 5; step += 1) {
      fireEvent.keyDown(document.activeElement!, { key: "=", ctrlKey: true });
      await act(async () => {});
    }
    expect(await screen.findByText("Zoom 200%")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open navigation" }),
    );
    const search = screen.getByRole("button", { name: "Search" });
    // A pointer invocation does not have to focus the button first.
    fireEvent.click(search);
    const filter = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.change(filter, { target: { value: "> Reset zoom" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(await screen.findByText("Zoom 100%")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Search or jump to…" }),
      ),
    );
  } finally {
    uninstall();
  }
});

test("a newer typed Title keeps focus and its draft while delayed native zoom changes layout", async () => {
  let finish: (() => void) | undefined;
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (
      command === "plugin:window|set_background_color" ||
      command === "plugin:webview|set_webview_background_color"
    )
      return;
    if (command === "plugin:webview|set_webview_zoom")
      return new Promise<void>((resolve) => {
        finish = () => {
          resizeViewport((args as { value: number }).value >= 1.75);
          resolve();
        };
      });
    return bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1]);
  });
  render(<App />);
  const jump = await screen.findByRole("button", {
    name: "Search or jump to…",
  });
  jump.focus();
  const uninstall = installNativeZoomBridge();
  try {
    fireEvent.keyDown(jump, { key: "=", ctrlKey: true });
    // Queue the final target while native zoom is still pending.
    for (let step = 0; step < 4; step += 1)
      fireEvent.keyDown(jump, { key: "=", ctrlKey: true });
    fireEvent.click(sidebarNewTicket());
    const title = await screen.findByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, {
      target: { value: "Retain my responsive draft" },
    });
    await act(async () => finish?.());
    await act(async () => finish?.());
    expect(await screen.findByText("Zoom 200%")).toBeTruthy();
    expect(document.activeElement).toBe(title);
    expect((title as HTMLInputElement).value).toBe(
      "Retain my responsive draft",
    );
    fireEvent.keyDown(title, { key: "0", ctrlKey: true });
    await act(async () => finish?.());
    expect(await screen.findByText("Zoom 100%")).toBeTruthy();
    expect(document.activeElement).toBe(title);
    expect((title as HTMLInputElement).value).toBe(
      "Retain my responsive draft",
    );
  } finally {
    uninstall();
  }
});

function dialogAnimationSignals(slots = ["dialog-content", "dialog-overlay"]) {
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const actualStyle = window.getComputedStyle;
  // jsdom has no CSS animation engine. Supply only its live animation-name
  // signal to Radix; the assertions below concern draft, presence and focus.
  const style = vi
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element, pseudo) => {
      const native = actualStyle(element, pseudo);
      if (!slots.includes(element.getAttribute("data-slot") ?? ""))
        return native;
      return new Proxy(native, {
        get(target, key) {
          if (key === "animationName")
            return element.getAttribute("data-state") === "open"
              ? "test-enter"
              : "test-exit";
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
  const finishExit = (element: Element) => {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: "test-exit" });
    fireEvent(element, event);
  };
  return {
    finishExit,
    restore: () => {
      style.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

test("New ticket keeps its closing render until the browser exit finishes, then reopens with a fresh draft", async () => {
  const user = userEvent.setup();
  const { finishExit, restore } = dialogAnimationSignals();
  try {
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "find_tickets") return [bulkTicket(1)];
      return bridgeDefault(command, args);
    });
    render(<App />);
    const trigger = await screen.findByRole("button", {
      name: "New ticket",
    });
    expect(
      bridge.invoke.mock.calls.some(([command]) => command === "search_tags"),
    ).toBe(false);
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "New ticket" });
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog.isConnected).toBe(true);
    expect(
      within(dialog).getByRole("textbox", { name: "Title", hidden: true }),
    ).toHaveProperty("value", "");
    finishExit(dialog);
    finishExit(overlay);
    await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "New ticket" });
    const title = within(reopened).getByRole("textbox", { name: "Title" });
    expect(title).toHaveProperty("value", "");
    await user.type(title, "Keep this draft");
    const closingOverlay = document.querySelector(
      '[data-slot="dialog-overlay"]',
    )!;
    await user.keyboard("{Escape}");
    expect(reopened.isConnected).toBe(true);
    finishExit(reopened);
    finishExit(closingOverlay);
    await vi.waitFor(() => expect(reopened.isConnected).toBe(false));
    await user.click(trigger);
    const retained = await screen.findByRole("dialog", { name: "New ticket" });
    expect(
      within(retained).getByRole("textbox", { name: "Title" }),
    ).toHaveProperty("value", "Keep this draft");
  } finally {
    restore();
  }
});

test("conditional History, Cleanup and Restore dialogs keep their owner through exit and restore focus", async () => {
  const user = userEvent.setup();
  const { finishExit, restore } = dialogAnimationSignals([
    "dialog-content",
    "dialog-overlay",
    "dropdown-menu-content",
  ]);
  const doc = {
    id: "presence-doc",
    title: "Presence reader",
    body: "Reader stays put",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    trashed: false,
  };
  const file = {
    id: "presence-file",
    display_name: "kept.txt",
    original_filename: "kept.txt",
    kind: "local_snapshot",
    locator: "fixture/kept",
    size_bytes: 4,
  };
  const backup = "/tmp/lifecycle-backup.ticketd-backup";
  const summary = {
    last_change: null,
    tickets: 1,
    documents: 1,
    activities: 0,
    evidence: 0,
    projects: 0,
    plans: 0,
  };
  try {
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "find_tickets") return [bulkTicket(1)];
      if (command === "recent_documents")
        return [{ id: doc.id, heading: doc.title }];
      if (command === "open_document" || command === "show_document")
        return doc;
      if (
        command === "document_tags" ||
        command === "record_versions" ||
        command === "attachment_cleanup_reviews"
      )
        return [];
      if (command === "document_version") return [doc.updated_at, false];
      if (command === "search_attachments")
        return [
          {
            attachment: file,
            related: false,
            usage: {
              eligible: true,
              protections: [],
              legacy_drafts_pending: false,
            },
          },
        ];
      if (command === "safety_backups")
        return [
          {
            path: backup,
            kind: "safety",
            saved_at: doc.updated_at,
            size_bytes: 1024,
          },
        ];
      if (command === "inspect_backup")
        return {
          path: backup,
          current: summary,
          check: { status: "valid", format_version: 19, summary },
        };
      return bridgeDefault(command, args);
    });
    render(<App />);
    await screen.findByRole("button", { name: /First/ });
    expect(
      bridge.invoke.mock.calls.some(([command]) =>
        [
          "record_versions",
          "attachment_cleanup_reviews",
          "inspect_backup",
        ].includes(command),
      ),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Documents" }));
    await user.click(await screen.findByRole("button", { name: doc.title }));
    const actions = await screen.findByRole("button", {
      name: "Document actions",
    });
    actions.focus();
    await user.keyboard("{Enter}");
    const historyItem = await screen.findByRole("menuitem", {
      name: "History…",
    });
    const historyMenu = screen.getByRole("menu");
    await user.click(historyItem);
    const history = await screen.findByRole("dialog", { name: "History" });
    await vi.waitFor(() =>
      expect(historyMenu.hasAttribute("inert")).toBe(true),
    );
    finishExit(historyMenu);
    await vi.waitFor(() => expect(historyMenu.isConnected).toBe(false));
    expect(history.contains(document.activeElement)).toBe(true);
    let overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    await user.keyboard("{Escape}");
    expect(history.isConnected).toBe(true);
    finishExit(history);
    finishExit(overlay);
    await vi.waitFor(() => expect(history.isConnected).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(actions));
    await user.click(screen.getByRole("button", { name: "Attachments" }));
    await screen.findByRole("button", { name: file.display_name });
    const more = screen.getByRole("button", { name: "More library actions" });
    more.focus();
    await user.keyboard("{Enter}");
    const cleanupItem = await screen.findByRole("menuitem", {
      name: "Clean up unused files…",
    });
    const cleanupMenu = screen.getByRole("menu");
    await user.click(cleanupItem);
    const cleanup = await screen.findByRole("dialog", {
      name: "Clean up unused files",
    });
    await vi.waitFor(() =>
      expect(cleanupMenu.hasAttribute("inert")).toBe(true),
    );
    finishExit(cleanupMenu);
    await vi.waitFor(() => expect(cleanupMenu.isConnected).toBe(false));
    expect(cleanup.contains(document.activeElement)).toBe(true);
    overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    await user.keyboard("{Escape}");
    expect(cleanup.isConnected).toBe(true);
    finishExit(cleanup);
    finishExit(overlay);
    await vi.waitFor(() => expect(cleanup.isConnected).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(more));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Backups" }));
    const review = await screen.findByRole("button", {
      name: `Restore… ${backup}`,
    });
    await user.click(review);
    const dialog = await screen.findByRole("dialog", {
      name: "Replace this workspace?",
    });
    overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    await user.keyboard("{Escape}");
    expect(dialog.isConnected).toBe(true);
    finishExit(dialog);
    finishExit(overlay);
    await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(review));
    expect(
      bridge.invoke.mock.calls.some(
        ([command]) => command === "restore_workspace",
      ),
    ).toBe(false);
  } finally {
    restore();
  }
});

test("Capture saves before its exit, retains the closing editor and reopens empty", async () => {
  const user = userEvent.setup();
  const { finishExit, restore } = dialogAnimationSignals();
  let saved: {
    id: string;
    title: string | null;
    body: string;
    created_at: string;
    updated_at: string;
    trashed: boolean;
  } | null = null;
  try {
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "find_tickets") return [bulkTicket(1)];
      if (command === "recent_documents")
        return saved
          ? [{ id: saved.id, heading: saved.title ?? "Captured thought" }]
          : [];
      if (command === "save_document") {
        saved = {
          id: "capture-presence",
          title: (args as { title: string | null }).title,
          body: (args as { body: string }).body,
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
          trashed: false,
        };
        return saved;
      }
      return bridgeDefault(command, args);
    });
    render(<App />);
    await screen.findByRole("button", { name: /First/ });
    await user.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "New Document" });
    await user.click(
      await within(dialog).findByRole("button", {
        name: "Edit Markdown source",
      }),
    );
    const source = within(dialog).getByRole("textbox", {
      name: "Your thought source",
    });
    fireEvent.change(source, {
      target: { value: "Retain this captured thought" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await vi.waitFor(() =>
      expect(dialog.getAttribute("data-state")).toBe("closed"),
    );
    expect(dialog.isConnected).toBe(true);
    expect(source).toHaveProperty("value", "Retain this captured thought");
    expect(saved).toMatchObject({ body: "Retain this captured thought" });
    finishExit(dialog);
    await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
    await user.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
    const reopened = await screen.findByRole("dialog", {
      name: "New Document",
    });
    const editor = await within(reopened).findByRole("textbox", {
      name: "Your thought rich text",
    });
    expect(editor.textContent?.replaceAll("\ufeff", "")).toBe("");
  } finally {
    restore();
  }
});

test("a responsive navigation sheet hands focus to the visible sidebar when its focused row unmounts", async () => {
  narrowViewport = true;
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  const trigger = await screen.findByRole("button", {
    name: "Open navigation",
  });
  trigger.focus();
  fireEvent.click(trigger);
  const sheet = await screen.findByRole("dialog", { name: "Navigation" });
  within(sheet).getByRole("button", { name: "All tickets" }).focus();
  act(() => resizeViewport(false));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "All tickets" }),
    ),
  );
  act(() => resizeViewport(true));
  expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open navigation" }),
  );
});

test("Settings navigation keeps visible focus through narrow and wide replacements", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  const nav = await screen.findByRole("navigation", {
    name: "Settings sections",
  });
  fireEvent.click(within(nav).getByRole("button", { name: "Location" }));
  within(nav).getByRole("button", { name: "Appearance" }).focus();
  act(() => resizeViewport(true));
  const trigger = screen.getByRole("button", {
    name: /^Location, Settings sections/,
  });
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  const sheet = await screen.findByRole("dialog", { name: "Settings" });
  within(sheet).getByRole("button", { name: "Appearance" }).focus();
  act(() => resizeViewport(false));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Appearance" }),
    ),
  );
  expect(screen.getByRole("heading", { name: "Location" })).toBeTruthy();
  act(() => resizeViewport(true));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /^Location, Settings sections/ }),
  );
});

test("a retained native 200% reload initializes the palette and Reset recovers even after an unobserved change", async () => {
  let actualZoom = 2;
  const dpr = vi
    .spyOn(window, "devicePixelRatio", "get")
    .mockImplementation(() => actualZoom * 2);
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "plugin:window|scale_factor") return 2;
    // The window check half a second after mount reads the window size; answer
    // with one in step with the page, so it does not try a repair.
    if (command === "plugin:window|inner_size")
      return {
        width: window.innerWidth * actualZoom * 2,
        height: window.innerHeight * actualZoom * 2,
      };
    if (command === "plugin:window|is_decorated") return true;
    if (command === "plugin:window|set_theme") return;
    if (command === "plugin:webview|set_webview_zoom") {
      actualZoom = (args as { value: number }).value;
      return;
    }
    if (
      command === "plugin:window|set_background_color" ||
      command === "plugin:webview|set_webview_background_color"
    )
      return;
    return bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1]);
  });
  const uninstall = installNativeZoomBridge();
  try {
    const first = render(<App />);
    await screen.findByRole("button", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    let filter = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.change(filter, { target: { value: "> Zoom out" } });
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Zoom out/ }).textContent,
      ).toContain("200%"),
    );
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(await screen.findByText("Zoom 175%")).toBeTruthy();
    expect(actualZoom).toBe(1.75);
    first.unmount();
    render(<App />);
    await screen.findByRole("button", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    filter = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.change(filter, { target: { value: "> Reset zoom" } });
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Reset zoom/ }).textContent,
      ).toContain("175%"),
    );
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(await screen.findByText("Zoom 100%")).toBeTruthy();
    expect(actualZoom).toBe(1);
    // A real Reset must issue native recovery even if the last confirmed value was 100%.
    actualZoom = 2;
    fireEvent.keyDown(document.body, { key: "0", ctrlKey: true });
    await waitFor(() => expect(actualZoom).toBe(1));
  } finally {
    uninstall();
    dpr.mockRestore();
    sessionStorage.clear();
  }
});

test("a failed native Reset at confirmed 100% retries recovery instead of becoming a no-op", async () => {
  let reject = true;
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "plugin:webview|set_webview_zoom" && reject)
      return Promise.reject(new Error("Native Reset rejected"));
    return bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1]);
  });
  render(<App />);
  await screen.findByRole("button", { name: "Settings" });
  const uninstall = installNativeZoomBridge();
  try {
    fireEvent.keyDown(document.body, { key: "0", ctrlKey: true });
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("Couldn't change zoom");
    reject = false;
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Zoom 100%")).toBeTruthy();
    expect(nativeZoomCalls()).toHaveLength(2);
  } finally {
    uninstall();
  }
});

test.each(["MacIntel", "Win32"])(
  "%s preserves intentional 200% on focus and repairs a genuine display-scale loss",
  async (platform) => {
    const platformStub = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue(platform);
    let pageDpr = 4;
    const dpr = vi
      .spyOn(window, "devicePixelRatio", "get")
      .mockImplementation(() => pageDpr);
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(640);
    const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(400);
    bridge.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "plugin:window|scale_factor") return 2;
      if (command === "plugin:window|inner_size")
        return { width: 2560, height: 1600 };
      if (command === "plugin:window|is_maximized") return false;
      if (command === "plugin:window|is_decorated") return true;
      if (
        [
          "plugin:window|set_theme",
          "plugin:window|set_background_color",
          "plugin:webview|set_webview_background_color",
          "plugin:window|set_size",
        ].includes(command)
      )
        return;
      return bridgeDefault(
        command,
        args as Parameters<typeof bridgeDefault>[1],
      );
    });
    const uninstall = installNativeZoomBridge();
    try {
      render(<App />);
      await screen.findByRole("button", { name: "Settings" });
      // The shell owns the real startup/focus repair lifecycle. Its native
      // measurements are the independently observed Retina 100%/200% values.
      vi.useFakeTimers();
      fireEvent.focus(window);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(
        bridge.invoke.mock.calls.filter(
          ([command]) => command === "plugin:window|set_size",
        ),
      ).toEqual([]);
      pageDpr = 2; // WebView2 lost display scale while the intentional zoom remains 200%.
      width.mockReturnValue(1280);
      height.mockReturnValue(800);
      fireEvent.focus(window);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(
        bridge.invoke.mock.calls
          .filter(([command]) => command === "plugin:window|set_size")
          .map(([, args]) => JSON.parse(JSON.stringify(args)) as unknown),
      ).toEqual([
        { label: "main", value: { Physical: { width: 2561, height: 1600 } } },
        { label: "main", value: { Physical: { width: 2560, height: 1600 } } },
      ]);
    } finally {
      uninstall();
      platformStub.mockRestore();
      dpr.mockRestore();
      width.mockRestore();
      height.mockRestore();
    }
  },
);

test("Settings Escape and palette Reset return to visible section navigation without taking newer search focus", async () => {
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (
      command === "plugin:window|set_background_color" ||
      command === "plugin:webview|set_webview_background_color"
    )
      return;
    if (command === "plugin:webview|set_webview_zoom") {
      resizeViewport((args as { value: number }).value >= 1.75);
      return;
    }
    return bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1]);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  const nav = await screen.findByRole("navigation", {
    name: "Settings sections",
  });
  within(nav).getByRole("button", { name: "Appearance" }).focus();
  const uninstall = installNativeZoomBridge();
  try {
    for (let step = 0; step < 5; step += 1) {
      fireEvent.keyDown(document.activeElement!, { key: "=", ctrlKey: true });
      await act(async () => {});
    }
    expect(await screen.findByText("Zoom 200%")).toBeTruthy();
    const trigger = screen.getByRole("button", {
      name: /^Appearance, Settings sections/,
    });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.keyDown(trigger, { key: "k", ctrlKey: true });
    const filter = await screen.findByRole("combobox", {
      name: "Search tickets and destinations",
    });
    fireEvent.change(filter, { target: { value: "> Reset zoom" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Appearance" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Search settings" }));
    const search = await screen.findByRole("searchbox", {
      name: "Search settings",
    });
    search.focus();
    fireEvent.change(search, {
      target: { value: "retain this settings query" },
    });
    act(() => resizeViewport(true));
    expect(document.activeElement).toBe(search);
    act(() => resizeViewport(false));
    expect(document.activeElement).toBe(search);
    expect(search).toHaveProperty("value", "retain this settings query");
  } finally {
    uninstall();
  }
});

test("zoom keys wait for retained native scale and keep the latest Reset while initialization is pending", async () => {
  let finishScale: ((scale: number) => void) | undefined;
  let actualZoom = 2;
  const dpr = vi
    .spyOn(window, "devicePixelRatio", "get")
    .mockImplementation(() => actualZoom * 2);
  bridge.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "plugin:window|scale_factor")
      return new Promise<number>((resolve) => {
        finishScale = resolve;
      });
    if (command === "plugin:window|is_decorated") return true;
    if (
      [
        "plugin:window|set_theme",
        "plugin:window|set_background_color",
        "plugin:webview|set_webview_background_color",
      ].includes(command)
    )
      return;
    if (command === "plugin:webview|set_webview_zoom") {
      actualZoom = (args as { value: number }).value;
      return;
    }
    return bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1]);
  });
  const uninstall = installNativeZoomBridge();
  try {
    render(<App />);
    await screen.findByRole("button", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "-", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "-", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "0", ctrlKey: true });
    expect(nativeZoomCalls()).toHaveLength(0);
    await act(async () => finishScale?.(2));
    expect(await screen.findByText("Zoom 100%")).toBeTruthy();
    expect(actualZoom).toBe(1);
    expect(nativeZoomCalls().map(([, args]) => args)).toEqual([
      { label: "main", value: 1.75 },
      { label: "main", value: 1 },
    ]);
    // Following the retained 200% read, the next step starts from the confirmed Reset.
    fireEvent.keyDown(document.body, { key: "=", ctrlKey: true });
    expect(await screen.findByText("Zoom 110%")).toBeTruthy();
  } finally {
    uninstall();
    dpr.mockRestore();
  }
});

test("Document History keeps an unconfirmed restore private and retries the same request", async () => {
  const user = userEvent.setup();
  const doc = {
    id: "restore-history-doc",
    title: "Restore history reader",
    body: "Current paragraph",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    trashed: false,
  };
  const requests: unknown[] = [];
  bridge.invoke.mockImplementation((command: string, args) => {
    if (command === "recent_documents")
      return [{ id: doc.id, heading: doc.title }];
    if (command === "open_document" || command === "show_document") return doc;
    if (command === "document_tags") return [];
    if (command === "document_version") return [doc.updated_at, false];
    if (command === "record_versions")
      return [
        {
          id: "old",
          timestamp: doc.updated_at,
          device: "Studio desktop",
          changed: ["body"],
        },
      ];
    if (command === "record_version")
      return {
        fields: [
          { field: "body", value: "Earlier paragraph", current: doc.body },
        ],
      };
    if (command === "restore_record_version") {
      requests.push(args);
      if (requests.length === 1)
        throw new Error("Synthetic restore failed: /private/workspace.sqlite");
      doc.body = "Earlier paragraph";
      return null;
    }
    return bridgeDefault(command, args);
  });
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Documents" }));
  await user.click(await screen.findByRole("button", { name: doc.title }));
  const actions = screen.getByRole("button", { name: "Document actions" });
  actions.focus();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "History…" }));
  const history = await screen.findByRole("dialog", { name: "History" });
  await within(history).findByText("Earlier");
  await user.click(within(history).getByRole("button", { name: "Restore" }));
  const alert = await within(history).findByRole("alert");
  expect(alert.textContent).toContain("The result couldn't be confirmed");
  expect(alert.textContent).not.toContain("nothing changed");
  expect(within(history).queryByText(/Synthetic restore failed/)).toBeNull();
  expect(
    within(history)
      .getByRole("button", { name: /Studio desktop/ })
      .getAttribute("aria-current"),
  ).toBe("true");
  await user.click(within(alert).getByRole("button", { name: "Details" }));
  expect(await screen.findByText(/Synthetic restore failed/)).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "History" })).toBe(history);
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "History" })).toBeNull(),
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await vi.waitFor(() => expect(document.activeElement).toBe(actions));
  expect(doc.body).toBe("Earlier paragraph");
});

async function renderReviewApp(handlers: Record<string, unknown>) {
  bridge.invoke.mockImplementation(async (command: string, args?: unknown) => {
    const value = handlers[command];
    if (typeof value === "function") return value(args);
    return (
      value ??
      bridgeDefault(command, args as Parameters<typeof bridgeDefault>[1])
    );
  });
  const { ChatClientContext } = await import("@/features/chats/client");
  const { createMockChatClient } = await import("@/features/chats/mock-client");
  render(
    <ChatClientContext value={createMockChatClient({ enabled: true })}>
      <App />
    </ChatClientContext>,
  );
  await act(async () => {});
}

const reviewSource = {
  provider: "github",
  provider_name: "GitHub",
  place: "acme/api",
  number: "#98",
  status_choices: ["Todo", "In progress", "In review"],
  id: "98",
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
};
const reviewSourceEntry = {
  connector: {
    provider: "github",
    name: "GitHub",
    contract_version: 1,
    capabilities: ["discover", "fetch", "comments", "publish"],
    schema: { fields: [] },
  },
  saved: {
    provider: "github",
    config: { repositories: ["acme/api"] },
    account: "octo",
    saved_at: "2026-02-01T00:00:00Z",
  },
};

test("a known ticket keeps its saved wrapped title and body while a fresh detail read is pending", async () => {
  const ticket = bulkTicket(1, {
    title:
      "A wrapped title from the existing list that needs several lines in a narrow document column",
    body: "The saved body remains readable while the detail read is pending.",
  });
  let resolve!: (value: unknown) => void;
  await renderReviewApp({
    find_tickets: [ticket],
    show_ticket: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: /A wrapped title from the existing list/,
    }),
  );
  const title = screen.getByRole("textbox", { name: "Title" });
  expect(title).toHaveProperty("value", ticket.title);
  expect(title).toHaveProperty("disabled", true);
  expect(screen.getByText(ticket.body)).toBeTruthy();
  const document = title.closest(".detail-content")!;
  expect(document.hasAttribute("inert")).toBe(true);
  expect(
    screen.getByText("Loading the latest ticket. Showing its saved copy."),
  ).toBeTruthy();
  await act(async () => {
    resolve(ticket);
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    ticket.title,
  );
  expect(
    screen.getByRole("textbox", { name: "Title" }).closest(".detail-content"),
  ).toBe(document);
  expect(document.hasAttribute("inert")).toBe(false);
});

test("Source refresh and its persisted failure keep raw diagnostics behind Details", async () => {
  const raw = "RAW-SOURCE-TRANSPORT-0xdead";
  const ticket = bulkTicket(1, {
    source: {
      ...reviewSource,
      last_error: { code: "unavailable", message: raw },
    },
  });
  await renderReviewApp({
    find_tickets: [ticket],
    show_ticket: ticket,
    list_sources: [reviewSourceEntry],
    refresh_sources: {
      imported: [],
      updated: [],
      unchanged: 0,
      failures: [
        {
          provider: "github",
          reference: "T-KQ1",
          code: "unavailable",
          message: raw,
        },
      ],
      refreshed_at: "2026-02-02T00:00:00Z",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*First/ }));
  await screen.findByRole("button", { name: "Source: acme/api#98" });
  fireEvent.click(screen.getByRole("button", { name: "Source: acme/api#98" }));
  expect(screen.queryByText(raw)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(raw)).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {});
  const failure = screen.getByRole("alert");
  expect(failure.textContent).toContain("Saved content is unchanged");
  expect(failure.textContent).not.toContain(raw);
  fireEvent.click(within(failure).getByRole("button", { name: "Details" }));
  expect(screen.getByText(raw)).toBeTruthy();
});

test("Automation settings retain a failed draft and known switch state while Details owns diagnostics", async () => {
  let fail = true;
  const raw = "RAW-AUTOMATION-SETTING-0xdead";
  await renderReviewApp({
    automation_runs_at_once: { runs: 2, default: 2, most: 10 },
    start_at_login: true,
    set_automation_runs_at_once: () => {
      if (fail) throw new Error(raw);
      return null;
    },
    set_start_at_login: () => {
      throw new Error(raw);
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("button", { name: /^Automations/ }),
  );
  const input = await screen.findByRole("spinbutton", { name: "Runs at once" });
  fireEvent.change(input, { target: { value: "4" } });
  fireEvent.blur(input);
  await act(async () => {});
  expect(input).toHaveProperty("value", "4");
  expect(screen.getByRole("alert").textContent).not.toContain(raw);
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(raw)).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {});
  expect(screen.getByText("Saved")).toBeTruthy();
  const toggle = screen.getByRole("switch", {
    name: "Start ticketd when you sign in",
  });
  fireEvent.click(toggle);
  await act(async () => {});
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("alert").textContent).not.toContain(raw);
});

test("a ticket run failure retains the run and retries its same action with raw text only in Details", async () => {
  let fail = true;
  const raw = "RAW-RUN-ACTION-0xdead";
  const ticket = bulkTicket(1);
  const run = {
    id: "run-review",
    automation_id: "automation-review",
    automation_name: "Review changes",
    status: "needs_attention",
    reason: "Review the outcome",
    needs_you: true,
    answer: null,
    automation_deleted: false,
    ticket: { id: "1", reference: "T-KQ1", title: "First" },
    created_at: "2026-11-16T00:00:00Z",
  };
  await renderReviewApp({
    find_tickets: [ticket],
    show_ticket: ticket,
    automation_run_list_for_ticket: [run],
    automation_run_dismiss: () => {
      if (fail) throw new Error(raw);
      return null;
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*First/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await act(async () => {});
  const alert = screen.getByRole("alert");
  expect(alert.textContent).not.toContain(raw);
  fireEvent.click(within(alert).getByRole("button", { name: "Details" }));
  expect(screen.getByText(raw)).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {});
  expect(
    bridge.invoke.mock.calls
      .filter(([cmd]) => cmd === "automation_run_dismiss")
      .map(([, args]) => args),
  ).toEqual([{ id: "run-review" }, { id: "run-review" }]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an unconfirmed publication hides diagnostics and prevents a blind second publish", async () => {
  const raw = "RAW-PUBLICATION-TRANSPORT-0xdead";
  const ticket = bulkTicket(1);
  await renderReviewApp({
    find_tickets: [ticket],
    show_ticket: ticket,
    list_sources: [reviewSourceEntry],
    preview_publication: {
      reference: "T-KQ1",
      provider: "github",
      provider_name: "GitHub",
      destination: "acme/api",
      destinations: ["acme/api"],
      title: "First",
      body: "",
      fingerprint: "00000000000000a1",
      eligibility: { kind: "eligible" },
      attempt: null,
    },
    publish_ticket: () => {
      throw { code: "publication_unresolved", message: raw };
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*First/ }));
  await screen.findByRole("textbox", { name: "Title" });
  await screen.findByRole("button", { name: "Ticket actions" });
  openMenu("Ticket actions");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Publish to GitHub…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Publish T-KQ1 to GitHub",
  });
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Publish issue" }),
  );
  await act(async () => {});
  const failure = within(dialog).getByRole("alert");
  expect(failure.textContent).toContain("The issue may already exist");
  expect(failure.textContent).not.toContain(raw);
  expect(
    within(dialog).getByRole("button", { name: "Publish issue" }),
  ).toHaveProperty("disabled", true);
  expect(within(dialog).queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(within(failure).getByRole("button", { name: "Details" }));
  expect(screen.getByText(raw)).toBeTruthy();
  expect(
    bridge.invoke.mock.calls.filter(([cmd]) => cmd === "publish_ticket"),
  ).toHaveLength(1);
});

test("a small Plan reaches a matching member after 250 workspace matches without an unbounded initial read", async () => {
  const plan = {
    id: "late-match-plan",
    name: "Late match Plan",
    archived: false,
  };
  const member = bulkTicket(301, { title: "Needle member", plan_id: plan.id });
  const matches = Array.from({ length: 301 }, (_, index) => ({
    id: index === 300 ? member.id : `outside-match-${index}`,
    kind: "ticket",
    label:
      index === 300 ? "T-KQ301 · Needle member" : `Needle outside ${index}`,
    state: "Todo",
    trashed: false,
    activity_detail: false,
  }));
  let searches = 0;
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans") return [plan];
      if (command === "find_tickets") return [member];
      if (command === "show_plan")
        return {
          plan,
          members: [member],
          documents: [],
          counts: counted({ todo: 1 }),
        };
      if (command === "workspace_graph") {
        const r = args.request as {
          search: string | null;
          hydrate_only: boolean;
          visible_ids: string[];
          cursor: string | null;
        };
        const offset = Number(r.cursor ?? 0);
        if (r.search && !r.hydrate_only) searches++;
        return {
          nodes: r.hydrate_only
            ? matches.filter((n) => r.visible_ids.includes(n.id))
            : matches.slice(offset, offset + 50),
          edges: [],
          node_tags: {},
          total: 301,
          omitted: false,
          omitted_groups: [],
          next_cursor:
            !r.hydrate_only && offset + 50 < matches.length
              ? String(offset + 50)
              : null,
        };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /^Late match Plan/ }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Flow" }));
  const card = await screen.findByRole("button", {
    name: "T-KQ301 Needle member",
  });
  card.focus();
  fireEvent.keyDown(card, { key: "G", shiftKey: true });
  const graph = await screen.findByRole("region", { name: "Workspace graph" });
  await within(graph).findByText("1 ticket, 0 Documents");
  fireEvent.click(within(graph).getByRole("button", { name: "Filter" }));
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "Needle" },
  });
  await within(graph).findByText(
    /Some matching items are outside this search window/,
  );
  expect(searches).toBeLessThanOrEqual(5);
  fireEvent.click(within(graph).getByRole("button", { name: "Filter" }));
  fireEvent.click(within(graph).getByRole("button", { name: "Load more" }));
  await within(graph).findByText("1 ticket, 0 Documents");
  expect(graph.querySelector('[data-id="301"]')).toBeTruthy();
  fireEvent.click(within(graph).getByRole("radio", { name: "List" }));
  expect(
    within(graph).getByRole("button", { name: "T-KQ301 · Needle member" }),
  ).toBeTruthy();
  expect(searches).toBe(7);
  expect(within(graph).queryByRole("button", { name: "Load more" })).toBeNull();
});

test.each(["Plan", "Workspace"])(
  "%s graph refresh retains its later window, filter, selection and next continuation",
  async (scope) => {
    const plan = {
      id: "revision-window",
      name: "Revision window",
      archived: false,
    };
    const members = Array.from({ length: 260 }, (_, index) =>
      bulkTicket(index + 1, {
        title: `Window member ${index + 1}`,
        plan_id: plan.id,
      }),
    );
    const nodes = members.map((ticket) => ({
      id: ticket.id,
      kind: "ticket",
      label: `${ticket.reference} · ${ticket.title}`,
      state: "Todo",
      trashed: false,
      activity_detail: false,
    }));
    let version = 0;
    const tokenBefore = bridge.token.next;
    bridge.token.next = () => version;
    let reads = 0;
    bridge.invoke.mockImplementation(
      (command: string, args: Record<string, unknown>) => {
        if (command === "list_plans") return [plan];
        if (command === "find_tickets") {
          const f = args.filter as { offset: number; limit: number };
          return members.slice(f.offset, f.offset + f.limit);
        }
        if (command === "show_plan") {
          reads++;
          return {
            plan,
            members: [],
            documents: [],
            counts: counted({ todo: 260 }),
          };
        }
        if (command === "workspace_graph") {
          const r = args.request as {
            hydrate_only: boolean;
            visible_ids: string[];
            cursor: string | null;
          };
          return {
            nodes: r.hydrate_only
              ? nodes.filter((n) => r.visible_ids.includes(n.id))
              : scope === "Workspace"
                ? nodes.slice(Number(r.cursor ?? 0), Number(r.cursor ?? 0) + 50)
                : [],
            edges: [],
            total: 260,
            node_tags: {},
            omitted: false,
            omitted_groups: [],
            next_cursor:
              !r.hydrate_only &&
              scope === "Workspace" &&
              Number(r.cursor ?? 0) + 50 < nodes.length
                ? String(Number(r.cursor ?? 0) + 50)
                : null,
          };
        }
        return bridgeDefault(command, args);
      },
    );
    try {
      render(<App />);
      if (scope === "Plan") {
        fireEvent.click(
          await screen.findByRole("button", { name: /^Revision window/ }),
        );
        fireEvent.click(screen.getByRole("radio", { name: "Flow" }));
        fireEvent.click(
          await screen.findByRole("button", { name: "Open the full graph" }),
        );
      } else
        fireEvent.click(
          await screen.findByRole("button", { name: "Workspace graph" }),
        );
      const graph = await screen.findByRole("region", {
        name: "Workspace graph",
      });
      await within(graph).findByText("119 tickets, 0 Documents");
      fireEvent.click(within(graph).getByRole("button", { name: "Filter" }));
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Type: All" }), {
        key: "Enter",
      });
      fireEvent.click(await screen.findByRole("option", { name: "Tickets" }));
      fireEvent.click(within(graph).getByRole("button", { name: "Filter" }));
      await act(async () => {});

      fireEvent.click(within(graph).getByRole("button", { name: "Load more" }));
      await waitFor(() =>
        expect(graph.querySelector('[data-id="120"]')).toBeTruthy(),
      );
      fireEvent.click(within(graph).getByRole("radio", { name: "List" }));
      const row = within(graph).getByRole("button", {
        name: "T-KQ120 · Window member 120",
      });
      fireEvent.click(row);
      row.focus();
      const before = [
        ...graph.querySelectorAll(".cgraph-scroll .cgraph-rows > li"),
      ].map((n) => n.textContent);
      const readBefore = reads;
      version++;
      await vi.waitFor(() => expect(reads).toBeGreaterThan(readBefore), {
        timeout: 4000,
      });
      await act(async () => {});
      expect(
        [...graph.querySelectorAll(".cgraph-scroll .cgraph-rows > li")].map(
          (n) => n.textContent,
        ),
      ).toEqual(before);
      expect(
        within(graph).getByRole("button", {
          name: "T-KQ120 · Window member 120",
        }),
      ).toBe(row);
      expect(document.activeElement).toBe(row);
      expect(
        within(graph).getByRole("button", { name: "Center here" }),
      ).toBeTruthy();
      fireEvent.click(within(graph).getByRole("button", { name: "Load more" }));
      await within(graph).findByRole("button", {
        name: "T-KQ239 · Window member 239",
      });
      expect(
        within(graph).getByRole("button", {
          name: "T-KQ260 · Window member 260",
        }),
      ).toBeTruthy();
      expect(
        within(graph).queryByRole("button", {
          name: "T-KQ1 · Window member 1",
        }),
      ).toBeNull();
    } finally {
      bridge.token.next = tokenBefore;
    }
  },
);

test.each(["confirmed", "lost reply"])(
  "publication %s keeps a failed read recoverable without sending another issue",
  async (outcome) => {
    const ticket = bulkTicket(1);
    const raw = "RAW-PUBLISH-READ-OR-REPLY";
    let published = false;
    let failRead = true;
    let writes = 0;
    const attempt = {
      id: "publication-followup",
      reference: "T-KQ1",
      provider: "github",
      destination: "acme/api",
      title: "First",
      body: "",
      state: "succeeded",
      started_at: "2026-11-16T00:00:00Z",
      updated_at: "2026-11-16T00:00:00Z",
      failure: null,
      issue: null,
    };
    await renderReviewApp({
      find_tickets: [ticket],
      list_sources: [reviewSourceEntry],
      show_ticket: () => {
        if (published && failRead) throw new Error(raw);
        return ticket;
      },
      preview_publication: {
        reference: "T-KQ1",
        provider: "github",
        provider_name: "GitHub",
        destination: "acme/api",
        destinations: ["acme/api"],
        title: "First",
        body: "",
        fingerprint: "00000000000000a1",
        eligibility: { kind: "eligible" },
        attempt: null,
      },
      publish_ticket: () => {
        writes++;
        published = true;
        if (outcome === "lost reply") throw new Error(raw);
        return { attempt, replayed: false };
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*First/ }));
    await screen.findByRole("button", { name: "Ticket actions" });
    openMenu("Ticket actions");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Publish to GitHub…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Publish T-KQ1 to GitHub",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Publish issue" }),
    );
    await act(async () => {});
    expect(
      within(dialog)
        .queryByRole("button", { name: "Publish issue" })
        ?.hasAttribute("disabled") ?? true,
    ).toBe(true);
    expect(
      within(dialog).getByText(
        outcome === "confirmed"
          ? "Publication confirmed."
          : "The outcome is not known.",
      ),
    ).toBeTruthy();
    const check = within(dialog).getByRole("button", {
      name: "Check saved state",
    });
    fireEvent.click(check);
    await act(async () => {});
    const alerts = within(dialog).getAllByRole("alert");
    expect(alerts.every((a) => !a.textContent?.includes(raw))).toBe(true);
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "Details" })[0]!,
    );
    expect(screen.getByText(raw)).toBeTruthy();
    expect(writes).toBe(1);
    fireEvent.keyDown(screen.getByText(raw), { key: "Escape" });
    failRead = false;
    fireEvent.click(check);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Publish T-KQ1 to GitHub" }),
      ).toBeNull(),
    );
    expect(writes).toBe(1);
  },
);

test("Run again remains blocked through pending and failed authoritative reads after a lost reply", async () => {
  const ticket = bulkTicket(1);
  const run = {
    id: "uncertain-run",
    automation_id: "review",
    automation_name: "Review",
    status: "needs_attention",
    reason: "Review outcome",
    needs_you: true,
    answer: null,
    automation_deleted: false,
    ticket: { id: "1", reference: "T-KQ1", title: "First" },
    created_at: "2026-11-16T00:00:00Z",
  };
  let writes = 0;
  let rejectRead: ((reason: unknown) => void) | undefined;
  let reconcile = false;
  await renderReviewApp({
    find_tickets: [ticket],
    show_ticket: ticket,
    automation_run_list_for_ticket: () => {
      if (!writes) return [run];
      if (reconcile) return [{ ...run, needs_you: false }];
      return new Promise((_resolve, reject) => {
        rejectRead = reject;
      });
    },
    automation_run_again: () => {
      writes++;
      throw new Error("RAW-LOST-RUN-REPLY");
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /T-KQ1.*First/ }));
  const again = await screen.findByRole("button", { name: "Run again" });
  fireEvent.click(again);
  await waitFor(() => expect(rejectRead).toBeTypeOf("function"));
  expect(again).toHaveProperty("disabled", true);
  fireEvent.click(again);
  expect(writes).toBe(1);
  await act(async () => {
    rejectRead!(new Error("RAW-RUN-READ-FAILURE"));
  });
  expect(again).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  const check = screen.getByRole("button", { name: "Check saved runs" });
  expect(
    screen.getAllByRole("alert").every((a) => !a.textContent?.includes("RAW-")),
  ).toBe(true);
  reconcile = true;
  fireEvent.click(check);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull(),
  );
  expect(writes).toBe(1);
});

test.each(["old first", "new first", "new focus"])(
  "Document Trash restore handles %s deferred reads without losing or stealing focus",
  async (order) => {
    const rows = [
      { id: "trash-alpha", heading: "Alpha" },
      { id: "trash-beta", heading: "Beta" },
    ];
    const tokenBefore = bridge.token.next;
    let version = 0;
    bridge.token.next = () => version;
    let reads = 0;
    let resolveOld: ((rows: unknown) => void) | undefined;
    let resolveNew: ((rows: unknown) => void) | undefined;
    bridge.invoke.mockImplementation((command: string, args) => {
      if (command === "trashed_documents") {
        reads++;
        if (reads === 1) return rows;
        return new Promise((resolve) => {
          if (reads === 2) resolveOld = resolve;
          else resolveNew = resolve;
        });
      }
      if (command === "set_document_trashed")
        return {
          id: "trash-alpha",
          title: "Alpha",
          body: "",
          trashed: false,
          created_at: "now",
          updated_at: "now",
        };
      return bridgeDefault(command, args);
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(
        await screen.findByRole("button", { name: "Documents" }),
      );
      const nav = await screen.findByRole("radio", { name: "Trash" });
      await user.click(nav);
      await screen.findByRole("button", { name: "Restore Alpha" });
      version++;
      await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"), {
        timeout: 4000,
      });
      await user.click(screen.getByRole("button", { name: "Restore Alpha" }));
      await waitFor(() => expect(resolveNew).toBeTypeOf("function"));
      if (order === "new focus") nav.focus();
      if (order === "new first") {
        await act(async () => {
          resolveNew!([rows[1]]);
        });
        await act(async () => {
          resolveOld!(rows);
        });
      } else {
        await act(async () => {
          resolveOld!(rows);
        });
        await act(async () => {
          resolveNew!([rows[1]]);
        });
      }
      expect(
        screen.queryByRole("button", { name: "Restore Alpha" }),
      ).toBeNull();
      expect(document.activeElement).toBe(
        order === "new focus"
          ? nav
          : screen.getByRole("button", { name: "Restore Beta" }),
      );
    } finally {
      bridge.token.next = tokenBefore;
    }
  },
);

test("many Plan filter windows retain bounded reads, full counts and identical Graph and List identities", async () => {
  const plans = Array.from({ length: 12 }, (_, index) => ({
    id: `late-plan-${index}`,
    name: `Late Plan ${index}`,
    archived: false,
  }));
  const members = plans.map((plan, index) =>
    bulkTicket(index + 1, {
      title: `Needle member ${index}`,
      plan_id: plan.id,
    }),
  );
  const all = [
    ...Array.from({ length: 250 }, (_, index) => ({
      id: `outside-${index}`,
      kind: "document",
      label: `Needle outside ${index}`,
      state: null,
      trashed: false,
      activity_detail: false,
    })),
    ...members.map((ticket) => ({
      id: ticket.id,
      kind: "ticket",
      label: `${ticket.reference} · ${ticket.title}`,
      state: "Todo",
      trashed: false,
      activity_detail: false,
    })),
  ];
  let planReads = 0;
  let filterReads = 0;
  bridge.invoke.mockImplementation(
    (command: string, args: Record<string, unknown>) => {
      if (command === "list_plans")
        return args.limit === undefined
          ? plans
          : plans.slice(
              Number(args.offset),
              Number(args.offset) + Number(args.limit),
            );
      if (command === "show_plan") {
        planReads++;
        return {
          plan: plans.find((p) => p.id === args.id),
          members: [],
          documents: [],
          counts: counted({ todo: 1 }),
        };
      }
      if (command === "find_tickets") {
        const f = args.filter as {
          plan: string | null;
          offset: number;
          limit: number;
        };
        return (
          f.plan ? members.filter((t) => t.plan_id === f.plan) : members
        ).slice(f.offset, f.offset + f.limit);
      }
      if (command === "workspace_graph") {
        const r = args.request as {
          search: string | null;
          hydrate_only: boolean;
          cursor: string | null;
          visible_ids: string[];
        };
        const offset = Number(r.cursor ?? 0);
        if (r.search && !r.hydrate_only) filterReads++;
        return {
          nodes: r.hydrate_only
            ? all.filter((n) => r.visible_ids.includes(n.id))
            : all.slice(offset, offset + 50),
          edges: [],
          node_tags: {},
          total: 262,
          omitted: false,
          omitted_groups: [],
          next_cursor:
            !r.hydrate_only && offset + 50 < all.length
              ? String(offset + 50)
              : null,
        };
      }
      return bridgeDefault(command, args);
    },
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workspace graph" }),
  );
  const graph = await screen.findByRole("region", { name: "Workspace graph" });
  await within(graph).findByText("Late Plan 7");
  planReads = 0;
  fireEvent.click(within(graph).getByRole("button", { name: "Filter" }));
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "Needle" },
  });
  await within(graph).findByText(
    /Some matching items are outside this search window/,
  );
  expect(planReads).toBeLessThanOrEqual(8);
  expect(filterReads).toBeLessThanOrEqual(6);
  fireEvent.click(within(graph).getByRole("button", { name: "Filter" }));
  fireEvent.click(within(graph).getByRole("button", { name: "Load more" }));
  await within(graph).findByText("Late Plan 7");
  await waitFor(() =>
    expect(graph.querySelector('[data-id="8"]')).toBeTruthy(),
  );
  expect(within(graph).getAllByText("1 ticket, 0 Documents")).toHaveLength(8);
  const drawn = [
    ...graph.querySelectorAll(".react-flow__node-card[data-id]"),
  ].map((n) => n.getAttribute("data-id"));
  fireEvent.click(within(graph).getByRole("radio", { name: "List" }));
  expect(
    graph.querySelectorAll(".cgraph-scroll .cgraph-rows > li"),
  ).toHaveLength(drawn.length);
  for (let index = 0; index < 8; index++)
    expect(
      within(graph).getByRole("button", {
        name: `T-KQ${index + 1} · Needle member ${index}`,
      }),
    ).toBeTruthy();
  // Finish this filter window, advance to the remaining Plans, then continue
  // their filter window. No omitted island is stranded behind a discarded cursor.
  fireEvent.click(within(graph).getByRole("button", { name: "Load more" }));
  await waitFor(() => expect(planReads).toBeGreaterThanOrEqual(20));
  fireEvent.click(within(graph).getByRole("button", { name: "Load more" }));
  await within(graph).findByRole("button", {
    name: "T-KQ12 · Needle member 11",
  });
});

test.each([false, true])(
  "a saturated Workspace island keeps every candidate reachable with an opaque next page (%s)",
  async (hasNextPage) => {
    const plan = {
      id: "saturated-plan",
      name: "Saturated island",
      archived: false,
    };
    const members = Array.from({ length: 119 }, (_, index) =>
      bulkTicket(index + 1, {
        title: `Island member ${index + 1}`,
        plan_id: plan.id,
      }),
    );
    const documents = Array.from({ length: 119 }, (_, index) => ({
      id: `island-doc-${index}`,
      heading: `Island Document ${index}`,
      trashed: false,
    }));
    const islandNodes = [
      ...members.map((t) => ({
        id: t.id,
        kind: "ticket",
        label: `${t.reference} · ${t.title}`,
        state: "Todo",
        trashed: false,
        activity_detail: false,
      })),
      ...documents.map((d) => ({
        id: d.id,
        kind: "document",
        label: d.heading,
        state: null,
        trashed: false,
        activity_detail: false,
      })),
    ];
    const outside = Array.from(
      { length: hasNextPage ? 90 : 40 },
      (_, index) => ({
        id: `candidate-${index}`,
        kind: "document",
        label: `Outside Document ${index}`,
        state: null,
        trashed: false,
        activity_detail: false,
      }),
    );
    // Ten current members precede distinct candidates; raw-page positions cannot
    // be counted from just the identities newly inserted into the drawing.
    const firstPage = [...islandNodes.slice(0, 10), ...outside.slice(0, 40)];
    const all = [...islandNodes, ...outside];
    let reads = 0;
    let version = 0;
    const tokenBefore = bridge.token.next;
    bridge.token.next = () => version;
    const candidateCursors: (string | null)[] = [];
    bridge.invoke.mockImplementation(
      (command: string, args: Record<string, unknown>) => {
        if (command === "list_plans")
          return args.limit === undefined || Number(args.offset) === 0
            ? [plan]
            : [];
        if (command === "show_plan") {
          reads++;
          return {
            plan,
            members: [],
            documents,
            counts: counted({ todo: 119 }),
          };
        }
        if (command === "find_tickets") {
          const f = args.filter as {
            offset: number;
            limit: number;
            plan: string | null;
          };
          return f.plan ? members.slice(f.offset, f.offset + f.limit) : [];
        }
        if (command === "workspace_graph") {
          const r = args.request as {
            hydrate_only: boolean;
            visible_ids: string[];
            cursor: string | null;
          };
          if (!r.hydrate_only) candidateCursors.push(r.cursor);
          return {
            nodes: r.hydrate_only
              ? all.filter((n) => r.visible_ids.includes(n.id))
              : r.cursor === "opaque|next:page%"
                ? outside.slice(40)
                : firstPage,
            edges: [],
            node_tags: {},
            total: hasNextPage ? 329 : 279,
            omitted: false,
            omitted_groups: [],
            next_cursor:
              !r.hydrate_only && hasNextPage && r.cursor === null
                ? "opaque|next:page%"
                : null,
          };
        }
        return bridgeDefault(command, args);
      },
    );
    try {
      render(<App />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Workspace graph" }),
      );
      const graph = await screen.findByRole("region", {
        name: "Workspace graph",
      });
      await within(graph).findByText("119 tickets, 119 Documents");
      expect(graph.textContent).toContain("250 items");
      const reached = new Set<string>();
      const allReached = new Set<string>();
      for (let page = 0; page < 6; page++) {
        const drawn = [...graph.querySelectorAll(".react-flow__node[data-id]")]
          .map((n) => n.getAttribute("data-id")!)
          .filter((id) => id === plan.id || all.some((n) => n.id === id));
        fireEvent.click(within(graph).getByRole("radio", { name: "List" }));
        const rows = [
          ...graph.querySelectorAll(".cgraph-scroll .cgraph-rows > li"),
        ];
        expect(rows).toHaveLength(drawn.length);
        drawn.forEach((id) => allReached.add(id));
        for (const node of outside) {
          const present = within(graph).queryByRole("button", {
            name: node.label,
          });
          expect(!!present).toBe(drawn.includes(node.id));
          if (present) reached.add(node.id);
        }
        if (page === 1) {
          const row = within(graph).getByRole("button", {
            name: "Outside Document 11",
          });
          fireEvent.click(row);
          row.focus();
          const before = rows.map((r) => r.textContent);
          const previousReads = reads;
          version++;
          await vi.waitFor(() => expect(reads).toBeGreaterThan(previousReads), {
            timeout: 4000,
          });
          await act(async () => {});
          expect(
            [...graph.querySelectorAll(".cgraph-scroll .cgraph-rows > li")].map(
              (r) => r.textContent,
            ),
          ).toEqual(before);
          expect(document.activeElement).toBe(row);
        }
        const more = within(graph).queryByRole("button", { name: "Load more" });
        if (!more) break;
        fireEvent.click(within(graph).getByRole("radio", { name: "Graph" }));
        fireEvent.click(
          within(graph).getByRole("button", { name: "Load more" }),
        );
        await act(async () => {});
      }
      expect(reached.size).toBe(hasNextPage ? 90 : 40);
      expect(allReached.size).toBe(hasNextPage ? 329 : 279);
      expect(
        within(graph).queryByRole("button", { name: "Load more" }),
      ).toBeNull();
      expect(
        candidateCursors.every(
          (value) => value === null || value === "opaque|next:page%",
        ),
      ).toBe(true);
      expect(candidateCursors.includes("opaque|next:page%")).toBe(hasNextPage);
      expect(reads).toBeLessThanOrEqual(6);
    } finally {
      bridge.token.next = tokenBefore;
    }
  },
);

test("scrolling Inbox group headings preserves the focused triage entry and keyboard navigation", async () => {
  const due = "2020-01-01T00:00:00Z";
  await renderReviewApp({
    inbox: [1, 2].map((id) => ({
      id,
      reference: `T-KQ${id}`,
      title: `Scroll reminder ${id}`,
      kind: "reminder",
      from_value: "",
      to_value: due,
      timestamp: due,
      read: false,
      editing_agent: null,
    })),
    reminder: due,
    set_inbox_read: () => null,
    find_tickets: [bulkTicket(1), bulkTicket(2)],
    show_ticket: ({ reference }: { reference: string }) =>
      bulkTicket(reference === "T-KQ1" ? 1 : 2),
  });
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  const first = await screen.findByRole("button", {
    name: /T-KQ1.*Scroll reminder 1.*Your reminder/,
  });
  const second = screen.getByRole("button", {
    name: /T-KQ2.*Scroll reminder 2.*Your reminder/,
  });
  fireEvent.click(first);
  first.focus();
  const heading = screen.getByRole("heading", { name: /Needs you/ });
  const scroller = first.closest(".inbox-body")!;
  let sectionTop = 4;
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        top: this.tagName === "SECTION" ? sectionTop : 0,
        left: 0,
        bottom: 36,
        right: 392,
        width: 392,
        height: 36,
        toJSON: () => ({}),
      };
    });
  try {
    for (const position of [-20, 4]) {
      sectionTop = position;
      fireEvent.scroll(scroller);
      expect(document.activeElement).toBe(first);
      expect(screen.getByRole("heading", { name: /Needs you/ })).toBe(heading);
      expect(first.closest(".inbox-entry")?.getAttribute("aria-current")).toBe(
        "true",
      );
    }
    fireEvent.keyDown(first, { key: "j" });
    await waitFor(() =>
      expect(second.closest(".inbox-entry")?.getAttribute("aria-current")).toBe(
        "true",
      ),
    );
    expect(document.activeElement).toBe(first);
  } finally {
    geometry.mockRestore();
  }
});

test.each(["unavailable", "mixed", "none"])(
  "Plan Next up distinguishes %s Ready work without contradicting Core counts",
  async (state) => {
    const plan = {
      id: "source-next-plan",
      name: "Source availability",
      archived: false,
    };
    const unavailable = bulkTicket(3, {
      title: "Unavailable Ready work",
      plan_id: plan.id,
      availability: state === "none" ? "Blocked" : "Ready",
      source: {
        ...reviewSource,
        unavailable: {
          code: "offline",
          message: "The source is offline.",
          since: "2026-11-16T00:00:00Z",
        },
      },
    });
    const usable = bulkTicket(2, {
      title: "Available Ready work",
      plan_id: plan.id,
      availability: "Ready",
    });
    const members = state === "mixed" ? [unavailable, usable] : [unavailable];
    await renderReviewApp({
      list_plans: [plan],
      find_tickets: members,
      show_plan: {
        plan,
        members: [],
        documents: [],
        counts: counted({ todo: members.length }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    const cards = await screen.findByRole("list", { name: "Active Plans" });
    await within(cards).findByText(`0 of ${members.length} done`);
    if (state === "unavailable") {
      expect(
        await within(cards).findByText("Ready work has unavailable sources"),
      ).toBeTruthy();
      expect(within(cards).getByText(/1 ready, 0 blocked/)).toBeTruthy();
      expect(within(cards).queryByText("No Ready tickets")).toBeNull();
    } else if (state === "mixed") {
      expect(
        await within(cards).findByRole("button", {
          name: "T-KQ2 Available Ready work",
        }),
      ).toBeTruthy();
      expect(within(cards).getByText(/2 ready, 0 blocked/)).toBeTruthy();
      expect(
        within(cards).queryByText("Ready work has unavailable sources"),
      ).toBeNull();
    } else {
      expect(await within(cards).findByText("No Ready tickets")).toBeTruthy();
      expect(within(cards).getByText(/0 ready, 1 blocked/)).toBeTruthy();
    }
    expect(
      within(cards).queryByRole("button", {
        name: "T-KQ3 Unavailable Ready work",
      }),
    ).toBeNull();
  },
);
