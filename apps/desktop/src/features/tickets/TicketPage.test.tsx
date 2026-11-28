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
import type { Ticket } from "@/lib/api/client";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { TickingChanges } from "@/test/ticking-changes";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { OpenTicket } from "./open-ticket";
import { TestOpenTicket } from "./open-ticket/testing";
import { TicketPage } from "./TicketPage";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const ticket: Ticket = {
  id: "1",
  reference: "T-KQ1",
  title: "Ship the rail",
  body: "A description to read.",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
};

// What the CLI has recorded as evidence; it grows while the page is open.
let evidence: object[] = [];
beforeEach(() => {
  evidence = [];
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket") return ticket;
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    if (command === "ticket_evidence_page")
      return { items: evidence, total: evidence.length };
    return bridgeDefault(command, args as { reference?: string });
  });
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

test("a change made by the CLI appears in a section of the open page", async () => {
  render(
    <TickingChanges>
      <OpenTicket reference="T-KQ1">
        <TicketPage
          active
          projects={[]}
          plans={[]}
          select={vi.fn()}
          noteTarget={null}
          mention={null}
          onMention={vi.fn()}
        />
      </OpenTicket>
    </TickingChanges>,
  );
  await screen.findByDisplayValue("Ship the rail");
  expect(screen.queryByText("Unit tests passed")).toBeNull();
  // The CLI records evidence; the page learns of it at the next change.
  evidence = [
    {
      id: "1",
      kind: "verification",
      name: "Tests",
      value: "Unit tests passed",
      created_at: "now",
      updated_at: "now",
      editing_agent: null,
    },
  ];
  expect(
    await screen.findByText("Unit tests passed", {}, { timeout: 5000 }),
  ).toBeTruthy();
});

test("Evidence previews the newest three and names the records behind the fold", async () => {
  const items = [
    "Deploy check",
    "Main build",
    "Unit tests",
    "Smoke run",
    "First check",
  ].map((name, index) => ({
    id: String(index),
    name,
    kind: "verification",
    value: `Outcome ${index}`,
    editing_agent: null,
    created_at: `2026-11-2${5 - index}T15:00:00Z`,
    updated_at: `2026-11-2${5 - index}T15:00:00Z`,
  }));
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "ticket_evidence_page") return { items, total: 5 };
    return bridgeDefault(command, args as { reference?: string });
  });
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketPage
        active
        projects={[]}
        plans={[]}
        select={vi.fn()}
        noteTarget={null}
        mention={null}
        onMention={vi.fn()}
      />
    </TestOpenTicket>,
  );
  const section = within(
    await screen.findByRole("region", { name: "Evidence" }),
  );
  const fold = await section.findByRole("button", {
    name: "2 more: Smoke run, First check",
  });
  const rows = () =>
    section
      .getAllByRole("listitem")
      .map((row) => within(row).getByText(/Outcome \d/).textContent);
  expect(rows()).toEqual(["Outcome 0", "Outcome 1", "Outcome 2"]);
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(section.queryByRole("button", { name: "Add evidence" })).toBeNull();
  fireEvent.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toEqual([
    "Outcome 0",
    "Outcome 1",
    "Outcome 2",
    "Outcome 3",
    "Outcome 4",
  ]);
});

test("saving a property reports the write once", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket" || command === "change_ticket")
      return { ...ticket, project_id: "p" };
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    return bridgeDefault(command, args as { reference?: string });
  });
  const signal = fakeChangeSignal();
  render(
    <TestOpenTicket ticket={ticket} signal={signal}>
      <TicketPage
        active
        projects={[{ id: "p", name: "Project", path: "/p", paths: [] }]}
        plans={[]}
        select={vi.fn()}
        noteTarget={null}
        mention={null}
        onMention={vi.fn()}
      />
    </TestOpenTicket>,
  );
  await screen.findByDisplayValue("Ship the rail");
  for (let turn = 0; turn < 4; turn += 1) await act(async () => {});
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add ticket property" }),
    { key: "Enter" },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Project" }));
  fireEvent.click(await screen.findByRole("option", { name: "Project" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "change_ticket",
      expect.anything(),
    ),
  );
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
  expect(signal.catchUps).toBe(1);
});
