// @vitest-environment jsdom
// Writes that start in the list or a Plan (mark a duplicate, remove from a
// Plan, add to a Plan, refresh sources) report themselves, so the open Ticket's
// page shows the result at once instead of at the next poll.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AddTicketsDialog } from "@/features/plans/AddTicketsDialog";
import { usePlanView } from "@/features/plans/usePlanView";
import type { Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { plansClient } from "@/lib/api/plans";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { deferred } from "@/lib/workspace-reads/test-support";
import { MarkDuplicateDialog } from "./MarkDuplicateDialog";
import { TestOpenTicket } from "./open-ticket/testing";
import { useOpenTicket } from "./open-ticket";
import { useTicketWorkspace } from "./useTicketWorkspace";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
  // A command no fake answers means the bridge contract moved under the test.
  expect(unknownCommands.splice(0)).toEqual([]);
});

const ticket: Ticket = {
  id: "1",
  reference: "T-KQ1",
  title: "Source",
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
const plan: Plan = {
  id: "plan-1",
  name: "Docs launch",
  archived: false,
  purpose: "",
};

// What the core holds now; every write below changes it.
let stored: Ticket;
// What the next source refresh finds, and whether the list can be read.
let changedBySources = true;
let listFails = false;
// While set, a failing list read waits for the test to let it fail.
let listGate: Promise<void> | null = null;
beforeEach(() => {
  listGate = null;
  stored = ticket;
  changedBySources = true;
  listFails = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "show_ticket":
          return args?.reference === "T-KQ1"
            ? stored
            : { ...ticket, id: "2", reference: "T-KQ2", title: "Canonical" };
        case "search_tickets":
          return [stored];
        case "preview_duplicate_dependencies":
          return {
            source: "T-KQ1",
            mode: "duplicate",
            waiting: [],
            canonical: "T-KQ2",
            edges: [],
            replacement_issues: [],
          };
        case "mark_duplicate_reviewed":
          stored = { ...stored, status: "Duplicate" };
          return stored;
        case "bulk_change":
          stored = {
            ...stored,
            plan_id:
              (args?.change as { plan_id?: string | null }).plan_id ?? null,
          };
          return [stored];
        case "set_plan":
          stored = {
            ...stored,
            plan_id: (args?.plan as string | null) ?? null,
          };
          return null;
        case "refresh_sources":
          if (changedBySources)
            stored = { ...stored, title: "Source, refreshed" };
          return {
            imported: [],
            updated: changedBySources ? ["T-KQ1"] : [],
            unchanged: changedBySources ? 0 : 1,
            failures: [],
            refreshed_at: "2026-01-01T00:00:00Z",
          };
        case "show_plan":
          return {
            plan,
            counts: {
              todo: 0,
              in_progress: 0,
              in_review: 0,
              done: 0,
              canceled: 0,
              duplicate: 0,
            },
            members: [],
          };
        case "create_ticket":
          return { ...ticket, id: "9", reference: "T-KQ9", title: "Created" };
        case "find_tickets_with_updates":
          if (listFails) {
            await listGate;
            throw { code: "failed", message: "database is busy" };
          }
          return [];
        case "search_documents":
          return [];
        default:
          return bridgeDefault(command);
      }
    },
  );
});

/** What the open Ticket's page shows of the Ticket. */
function Page() {
  const { record } = useOpenTicket();
  return (
    <p aria-label="page">
      {record.status} | {record.title} | {record.plan_id ?? "no plan"}
    </p>
  );
}
const page = () => screen.getByLabelText("page").textContent;

test("marking a duplicate from the list shows the new status on the page", async () => {
  render(
    <TestOpenTicket ticket={ticket}>
      <Page />
      <MarkDuplicateDialog open onOpenChange={() => {}} />
    </TestOpenTicket>,
  );
  fireEvent.change(
    screen.getByPlaceholderText("Search tickets by title or reference"),
    { target: { value: "source" } },
  );
  fireEvent.click(await screen.findByText("Source"));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(await screen.findByLabelText("Canonical ticket reference"), {
    target: { value: "T-KQ2" },
  });
  fireEvent.keyDown(
    screen.getByRole("textbox", { name: /ticket reference|endpoint/ }),
    { key: "Enter" },
  );
  const mark = await screen.findByRole("button", { name: "Mark duplicate" });
  await waitFor(() => expect((mark as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(mark);
  await waitFor(() => expect(page()).toContain("Duplicate"));
});

function RemoveFromPlan() {
  const state = usePlanView(plan.id, 0);
  return (
    <button
      type="button"
      onClick={() =>
        void state.apply(() => plansClient.setMember("T-KQ1", null))
      }
    >
      Remove from Plan
    </button>
  );
}

test("removing a Ticket from its Plan shows it on the page", async () => {
  render(
    <TestOpenTicket ticket={ticket}>
      <Page />
      <RemoveFromPlan />
    </TestOpenTicket>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove from Plan" }));
  await waitFor(() => expect(page()).toContain("no plan"));
});

test("a Plan action reads the Plan once: its write report already reloads it", async () => {
  render(
    <TestOpenTicket ticket={ticket}>
      <RemoveFromPlan />
    </TestOpenTicket>,
  );
  await waitFor(() => expect(reads("show_plan")).toBeGreaterThan(0));
  await turns();
  const before = reads("show_plan");
  fireEvent.click(screen.getByRole("button", { name: "Remove from Plan" }));
  await waitFor(() => expect(reads("set_plan")).toBeGreaterThan(0));
  await turns();
  expect(reads("show_plan") - before).toBe(1);
});

function AddToPlan() {
  const state = usePlanView(plan.id, 0);
  return (
    <AddTicketsDialog
      plan={plan}
      plans={[plan]}
      open
      onOpenChange={() => {}}
      state={state}
    />
  );
}

test("adding Tickets to a Plan shows the change on the page", async () => {
  stored = { ...ticket, plan_id: null };
  render(
    <TestOpenTicket ticket={stored}>
      <Page />
      <AddToPlan />
    </TestOpenTicket>,
  );
  expect(page()).toContain("no plan");
  fireEvent.change(
    screen.getByPlaceholderText("Search tickets by title or reference"),
    { target: { value: "source" } },
  );
  fireEvent.click(await screen.findByText("Source"));
  fireEvent.click(screen.getByRole("button", { name: /^Add ticket/ }));
  await waitFor(() => expect(page()).toContain("plan-1"));
});

function Sources() {
  const workspace = useTicketWorkspace(vi.fn(), vi.fn());
  return (
    <>
      <button type="button" onClick={() => void workspace.refreshSources()}>
        Refresh sources
      </button>
      <output aria-label="list failure">
        {workspace.listFailure?.sentence ?? "none"}
      </output>
    </>
  );
}

const reads = (command: string) =>
  bridge.invoke.mock.calls.filter(([c]) => c === command).length;
const turns = async () => {
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
};

/** Renders the Ticket and the list, both read once, then clicks Refresh sources. */
async function clickRefreshSources() {
  render(
    <TestOpenTicket ticket={ticket}>
      <Page />
      <Sources />
    </TestOpenTicket>,
  );
  await waitFor(() =>
    expect(reads("find_tickets_with_updates")).toBeGreaterThan(0),
  );
  await turns();
  const before = {
    lists: reads("find_tickets_with_updates"),
    tickets: reads("show_ticket"),
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh sources" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "refresh_sources",
      expect.anything(),
    ),
  );
  await turns();
  return {
    lists: () => reads("find_tickets_with_updates") - before.lists,
    tickets: () => reads("show_ticket") - before.tickets,
  };
}

test("refreshing sources that found something reads the list once and re-reads the open Ticket", async () => {
  const loads = await clickRefreshSources();
  expect(loads.lists()).toBe(1);
  expect(loads.tickets()).toBe(1);
});

test("refreshing sources that found nothing reads the list once and reports no write", async () => {
  changedBySources = false;
  const loads = await clickRefreshSources();
  expect(loads.lists()).toBe(1);
  // Nothing changed, so the open Ticket has nothing to re-read.
  expect(loads.tickets()).toBe(0);
});

test.each([true, false])(
  "a failed list reload after refreshing sources (found something: %s) says so",
  async (found) => {
    changedBySources = found;
    render(
      <TestOpenTicket ticket={ticket}>
        <Sources />
      </TestOpenTicket>,
    );
    await waitFor(() =>
      expect(reads("find_tickets_with_updates")).toBeGreaterThan(0),
    );
    await turns();
    expect(screen.getByLabelText("list failure").textContent).toBe("none");
    listFails = true;
    // The reload the click starts is still in flight when the report's own
    // reload takes over, so the failure must outlive that hand-over.
    const gate = deferred<void>();
    listGate = gate.promise;
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources" }));
    await turns();
    gate.resolve();
    await waitFor(() =>
      expect(screen.getByLabelText("list failure").textContent).not.toBe(
        "none",
      ),
    );
  },
);

test("refreshing sources shows what it changed on the page", async () => {
  render(
    <TestOpenTicket ticket={ticket}>
      <Page />
      <Sources />
    </TestOpenTicket>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh sources" }));
  await waitFor(() => expect(page()).toContain("Source, refreshed"));
});

function Creating() {
  const workspace = useTicketWorkspace(vi.fn(), vi.fn());
  return (
    <button
      type="button"
      onClick={() =>
        void workspace.create("Created", "", "Todo", null, null, [])
      }
    >
      Create
    </button>
  );
}

test("creating a Ticket reloads the list once: its write report already moves the shared version", async () => {
  render(
    <TestOpenTicket ticket={ticket}>
      <Creating />
    </TestOpenTicket>,
  );
  const lists = () =>
    bridge.invoke.mock.calls.filter(([c]) => c === "find_tickets_with_updates")
      .length;
  await waitFor(() => expect(lists()).toBeGreaterThan(0));
  await act(async () => {});
  const before = lists();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "create_ticket",
      expect.anything(),
    ),
  );
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
  expect(lists() - before).toBe(1);
});
