// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { usePlanView } from "@/features/plans/usePlanView";
import { TicketListSync } from "@/features/tickets/open-ticket";
import { useTicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import type { Ticket } from "@/lib/api/client";
import { plansClient } from "@/lib/api/plans";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { TestReads } from "@/lib/workspace-reads/testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const counts = {
  todo: 1,
  in_progress: 0,
  in_review: 0,
  done: 0,
  canceled: 0,
  duplicate: 0,
};
const ticket: Ticket = {
  id: "1",
  reference: "T-1",
  title: "One",
  body: "",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: "plan-1",
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
};
let planName: string;
let member: boolean;
const log: string[] = [];

beforeEach(() => {
  planName = "Launch";
  member = true;
  log.length = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      log.push(command);
      switch (command) {
        case "find_tickets_with_updates": {
          const tickets = member ? [ticket] : [];
          return args?.projection
            ? { items: tickets, omitted: false }
            : tickets.map((item) => ({ ticket: item, latest_update: null }));
        }
        case "count_tickets":
          return { total: 1, ...counts };
        case "list_plans":
          return [
            { id: "plan-1", name: planName, archived: false, purpose: "" },
          ];
        case "show_plan":
          return {
            plan: {
              id: "plan-1",
              name: planName,
              archived: false,
              purpose: "",
            },
            counts,
            members: member
              ? [
                  {
                    reference: "T-1",
                    title: "One",
                    status: "Todo",
                    project_id: null,
                    availability: "Ready",
                  },
                ]
              : [],
          };
        case "change_plan":
          planName = (args?.name as string | null) ?? planName;
          return null;
        case "set_plan":
          member = false;
          return null;
        default:
          return bridgeDefault(command, args as never);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

const reads = (command: string) => log.filter((c) => c === command).length;
const turns = async () => {
  for (let turn = 0; turn < 10; turn += 1) await act(async () => {});
};

// The App wiring: the workspace owns the shared version and the list, and the
// Plan view sits beside it as TicketWorkspaceView places it.
function Pane() {
  const workspace = useTicketWorkspace(vi.fn(), vi.fn());
  const plan = usePlanView("plan-1");
  const [renamed, setRenamed] = useState(false);
  return (
    <TicketListSync value={workspace.patchTicket}>
      <button
        type="button"
        onClick={() =>
          void plan
            .apply(() => plansClient.change("plan-1", "Renamed", null))
            .then(() => setRenamed(true))
        }
      >
        Rename
      </button>
      <button
        type="button"
        onClick={() =>
          void plan.apply(() => plansClient.setMember("T-1", null))
        }
      >
        Remove
      </button>
      <output aria-label="name">{plan.view?.plan.name ?? "none"}</output>
      <output aria-label="members">
        {plan.view?.members.length ?? "none"}
      </output>
      <output aria-label="after">{renamed ? plan.view?.plan.name : ""}</output>
    </TicketListSync>
  );
}

async function open() {
  render(
    <TestReads>
      <Pane />
    </TestReads>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("name").textContent).toBe("Launch"),
  );
  await turns();
}

test("the header shows the new name by the time the action resolves", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await waitFor(() =>
    expect(screen.getByLabelText("after").textContent).not.toBe(""),
  );
  expect(screen.getByLabelText("after").textContent).toBe("Renamed");
});

test("an action that changes the Plan's members reads the Plan once", async () => {
  await open();
  const before = reads("show_plan");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(screen.getByLabelText("members").textContent).toBe("0"),
  );
  await turns();
  expect(reads("show_plan") - before).toBe(1);
});
