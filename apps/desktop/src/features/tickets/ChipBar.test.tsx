// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TicketDetails } from "./TicketDetails";
import { TestReads } from "@/lib/workspace-reads/testing";
import type { Ticket } from "@/lib/api/client";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));

// The pane width is the only input: tests set it through the observer.
let callbacks: ResizeObserverCallback[] = [];
window.ResizeObserver = class {
  constructor(callback: ResizeObserverCallback) {
    callbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};
function resizePane(width: number) {
  act(() => {
    for (const callback of callbacks)
      callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
  });
}
Element.prototype.scrollIntoView = () => {};

const changes: object[] = [];
let following = false;
beforeEach(() => {
  callbacks = [];
  following = false;
  changes.length = 0;
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket") return ticket;
    if (command === "is_following") return following;
    if (command === "reminder") return null;
    if (command === "set_following") {
      following = (args as { following: boolean }).following;
      return null;
    }
    if (command === "change_ticket") {
      changes.push(args as object);
      return { ...ticket, project_id: "p1" };
    }
    return bridgeDefault(command, args as { reference?: string });
  });
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

const ticket: Ticket = {
  id: "1",
  reference: "T-KQ1",
  title: "Ship the rail",
  body: "A description to read.",
  status: "In progress",
  trashed: false,
  tags: ["release"],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
};
function renderDetails() {
  render(
    <TestReads primed={{ ticket: ticket }}>
      <TicketDetails
        mention={null}
        selected={ticket.reference}
        expanded={false}
        onExpand={vi.fn()}
        onReturn={vi.fn()}
        setSelected={vi.fn()}
        opened={[ticket.reference]}
        onMentionReady={vi.fn()}
        onClearMention={vi.fn()}
        projects={[{ id: "p1", name: "Web portal" } as never]}
        plans={[]}
        position={{ index: 2, total: 11 }}
        onAdjacent={vi.fn()}
      />
    </TestReads>,
  );
}

test("a wide pane keeps the same wrapping property bar", async () => {
  renderDetails();
  resizePane(900);
  expect(
    await screen.findByRole("group", { name: "Ticket properties" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("complementary", { name: "Ticket properties" }),
  ).toBeNull();
});

test("a narrow pane shows only present properties and adds a project through the plus menu", async () => {
  renderDetails();
  resizePane(500);
  const bar = await screen.findByRole("group", { name: "Ticket properties" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(
    within(bar)
      .getAllByRole("button")
      .map((chip) => chip.getAttribute("aria-label")),
  ).toEqual(["Status: In progress", "Tags: release", "Add ticket property"]);
  expect(bar.textContent).not.toContain("Local");
  // Follow is an icon toggle: its name stays "Follow" and aria-pressed says
  // whether it is on.
  const follow = screen.getByRole("button", { name: "Follow" });
  expect(follow.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(follow);
  await waitFor(() => expect(follow.getAttribute("aria-pressed")).toBe("true"));

  fireEvent.keyDown(
    within(bar).getByRole("button", { name: "Add ticket property" }),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Tags" })).toBeNull();
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Project",
    "PlanL",
    "ReminderH",
    "Blocked by…B",
    "Parent…",
    "Subticket…",
    "Link a ticket…",
    "Evidence…",
    "File…",
    "Document…",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Project" }));
  fireEvent.click(await screen.findByRole("option", { name: "Web portal" }));
  await waitFor(() =>
    expect(changes).toEqual([expect.objectContaining({ reference: "T-KQ1" })]),
  );
});

test("widening the pane keeps the same bar", async () => {
  renderDetails();
  resizePane(500);
  await screen.findByRole("group", { name: "Ticket properties" });
  resizePane(800);
  expect(
    await screen.findByRole("group", { name: "Ticket properties" }),
  ).toBeTruthy();
});

test("a hidden pane reports no width and keeps its layout", async () => {
  renderDetails();
  resizePane(900);
  await screen.findByRole("group", { name: "Ticket properties" });
  resizePane(0);
  expect(screen.getByRole("group", { name: "Ticket properties" })).toBeTruthy();
  expect(
    screen.queryByRole("complementary", { name: "Ticket properties" }),
  ).toBeNull();
});

test("narrow, an agent update keeps its reserved strip after the property controls", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "latest_update")
      return {
        activity_id: "a-1",
        brief: { text: "Drafted a fix", truncated: false },
        reported_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        editing_agent: "codex",
        supporting_document_id: null,
      };
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    return bridgeDefault(command, args as { reference?: string });
  });
  renderDetails();
  resizePane(500);
  const bar = await screen.findByRole("group", { name: "Ticket properties" });
  // One line: who and when, then the excerpt.
  const latest = (await screen.findByText(/Drafted a fix/)).closest(
    ".ticket-agent-strip",
  )!;
  expect(latest.textContent).toMatch(/^codex · .*Drafted a fix/);
  // On its own line after the last chip, not between Status and the others.
  const last = within(bar).getByRole("button", { name: "Add ticket property" });
  expect(
    last.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
