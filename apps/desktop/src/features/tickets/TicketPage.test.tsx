// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { TickingChanges } from "@/test/ticking-changes";
import { OpenTicket } from "./open-ticket";
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
    if (command === "list_evidence") return evidence;
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
          onOpenGraph={vi.fn()}
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
