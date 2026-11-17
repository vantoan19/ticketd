// @vitest-environment jsdom
// Writes that start in the list or a Plan (mark a duplicate, remove from a
// Plan, add to a Plan, refresh sources) report themselves, so the open Ticket's
// page shows the result at once instead of at the next poll.
import {
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
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
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
beforeEach(() => {
  stored = ticket;
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
          stored = { ...stored, title: "Source, refreshed" };
          return {
            imported: [],
            updated: ["T-KQ1"],
            unchanged: 0,
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
        case "find_tickets_with_updates":
        case "search_documents":
          return [];
        default:
          return null;
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
    <button type="button" onClick={() => void workspace.refreshSources()}>
      Refresh sources
    </button>
  );
}

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
