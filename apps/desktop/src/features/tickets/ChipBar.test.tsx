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
beforeEach(() => {
  callbacks = [];
  changes.length = 0;
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    if (command === "set_following") return null;
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
    <TicketDetails
      mention={null}
      selected={ticket.reference}
      expanded={false}
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ [ticket.reference]: ticket }}
      projects={[{ id: "p1", name: "Web portal" } as never]}
      plans={[]}
      revision={0}
      refresh={vi.fn(async () => {})}
      updateTicket={vi.fn()}
      position={{ index: 2, total: 11 }}
      onAdjacent={vi.fn()}
    />,
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

test("a narrow pane folds the rail into chips that open the same editors", async () => {
  renderDetails();
  resizePane(500);
  const bar = await screen.findByRole("group", { name: "Ticket properties" });
  expect(screen.queryByRole("complementary")).toBeNull();
  // Rail order, each chip named by its property and value. No source is set
  // up, so there is no Source chip and nothing says "Local".
  await within(bar).findByRole("button", { name: "Follow" });
  expect(
    [...bar.querySelectorAll("button, [role=combobox]")].map(
      (chip) => chip.getAttribute("aria-label") ?? chip.textContent,
    ),
  ).toEqual([
    "Status: In progress",
    "Project: No project",
    "Plan: No Plan",
    "Tags: release",
    "Follow",
    "Manage reminder",
    "Add ticket property",
  ]);
  expect(bar.textContent).not.toContain("Local");
  // Follow is an icon toggle: its name stays "Follow" and aria-pressed says
  // whether it is on.
  const follow = within(bar).getByRole("button", { name: "Follow" });
  expect(follow.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(follow);
  await waitFor(() => expect(follow.getAttribute("aria-pressed")).toBe("true"));

  // The Project chip opens the rail's picker, and choosing saves.
  fireEvent.click(
    within(bar).getByRole("button", { name: "Project: No project" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Web portal" }));
  await waitFor(() =>
    expect(changes).toEqual([expect.objectContaining({ reference: "T-KQ1" })]),
  );
});

test("narrow, Relationships and Documents follow the description as a section", async () => {
  renderDetails();
  resizePane(500);
  const bar = await screen.findByRole("group", { name: "Ticket properties" });
  const connected = await screen.findByRole("heading", {
    name: "Relationships",
  });
  expect(bar.contains(connected)).toBe(false);
  expect(
    screen
      .getByText("A description to read.")
      .compareDocumentPosition(connected) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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

test("narrow, an active ticket still shows its Latest update under the chips", async () => {
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
  const latest = (await within(bar).findByText("Drafted a fix")).parentElement!;
  expect(latest.textContent).toMatch(/^codex · .*Drafted a fix$/);
  // On its own line after the last chip, not between Status and the others.
  const last = within(bar).getByRole("button", { name: "Manage reminder" });
  expect(
    last.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
