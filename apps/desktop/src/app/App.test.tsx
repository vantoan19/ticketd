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
Element.prototype.scrollIntoView = () => {};

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
  fireEvent.click(
    screen.getAllByRole("button", { name: "T-KQ1 · First" }).at(-1)!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Center here" }));
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
    await screen.findByRole("button", { name: "Edit description" }),
  );
  const editor = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  editor.focus();
  expect(fireEvent.keyDown(editor, { key: "k", ctrlKey: true })).toBe(true);
  expect(screen.queryByRole("dialog", { name: "Go anywhere" })).toBeNull();
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
