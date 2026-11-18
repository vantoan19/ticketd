// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { TestReads } from "@/lib/workspace-reads/testing";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { TicketDetails } from "./TicketDetails";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const ticket = (reference: string, title: string): Ticket => ({
  id: reference,
  reference,
  title,
  status: "Todo",
  trashed: false,
  body: "",
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
});

const records = () =>
  bridge.invoke.mock.calls
    .filter(([command]) => command === "show_ticket")
    .map(([, args]) => (args as { reference: string }).reference);

beforeEach(() => {
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket") {
      const { reference } = args as { reference: string };
      return ticket(reference, `Title of ${reference}`);
    }
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    // A save that never answers keeps a draft unsaved.
    if (command === "change_ticket") return new Promise(() => {});
    return bridgeDefault(command, args as { reference?: string });
  });
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

test("a ticket opened earlier keeps its page but reads nothing while another is selected", async () => {
  const signal = fakeChangeSignal();
  const props = {
    mention: null,
    expanded: false,
    onExpand: vi.fn(),
    onReturn: vi.fn(),
    setSelected: vi.fn(),
    opened: ["T-KQ1", "T-KQ2"],
    onMentionReady: vi.fn(),
    onClearMention: vi.fn(),
    projects: [],
    plans: [],
  };
  const view = (selected: string) => (
    <TestReads signal={signal}>
      <TicketDetails {...props} selected={selected} />
    </TestReads>
  );
  const { rerender } = render(view("T-KQ1"));
  expect(await screen.findByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Title of T-KQ1",
  );
  rerender(view("T-KQ2"));
  expect(await screen.findByDisplayValue("Title of T-KQ2")).toBeTruthy();
  // T-KQ1's page is still there, hidden, and was never read a second time.
  expect(screen.getByDisplayValue("Title of T-KQ1")).toBeTruthy();
  expect(records()).toEqual(["T-KQ1", "T-KQ2"]);
});

test("only the selected page, the three opened before it and pages with an unsaved draft stay mounted", async () => {
  const signal = fakeChangeSignal();
  const props = {
    mention: null,
    expanded: false,
    onExpand: vi.fn(),
    onReturn: vi.fn(),
    setSelected: vi.fn(),
    onMentionReady: vi.fn(),
    onClearMention: vi.fn(),
    projects: [],
    plans: [],
  };
  // The workspace lists opened Tickets least recently selected first.
  const view = (opened: string[]) => (
    <TestReads signal={signal}>
      <TicketDetails {...props} opened={opened} selected={opened.at(-1)!} />
    </TestReads>
  );
  const { rerender } = render(view(["T-KQ1"]));
  const title = await screen.findByDisplayValue("Title of T-KQ1");
  fireEvent.change(title, { target: { value: "An unsaved title" } });
  const opened = ["T-KQ1"];
  for (const reference of ["T-KQ2", "T-KQ3", "T-KQ4", "T-KQ5", "T-KQ6"]) {
    opened.push(reference);
    rerender(view([...opened]));
    expect(
      await screen.findByDisplayValue(`Title of ${reference}`),
    ).toBeTruthy();
  }
  expect(screen.getByDisplayValue("An unsaved title")).toBeTruthy();
  expect(screen.queryByDisplayValue("Title of T-KQ2")).toBeNull();
  for (const kept of ["T-KQ3", "T-KQ4", "T-KQ5"])
    expect(screen.getByDisplayValue(`Title of ${kept}`)).toBeTruthy();
});
