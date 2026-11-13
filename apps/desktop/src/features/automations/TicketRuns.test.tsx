// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { TicketRun } from "@/features/automations/client";
import { RunNavigation } from "@/features/automations/navigation";
import {
  RunNotices,
  TicketRunsSection,
} from "@/features/automations/TicketRuns";
import { useTicketRuns } from "@/features/automations/use-ticket-runs";
import { ChatFeatureContext } from "@/features/chats/use-chats";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const LIMIT = "The agent reached its limit of 40 turns before finishing.";
const ticketRun = (patch: Partial<TicketRun>): TicketRun => ({
  id: "run-1",
  automation_id: "automation-1",
  automation_name: "Triage new tickets",
  status: "completed",
  reason: null,
  needs_you: false,
  ticket: { id: "t-8", reference: "T-ZB8", title: "Login form flickers" },
  created_at: new Date().toISOString(),
  ...patch,
});
const FAILED = ticketRun({
  status: "needs_attention",
  reason: LIMIT,
  needs_you: true,
});

/** The fake Workspace's runs of the ticket, changed by the commands sent. */
let runs: TicketRun[] = [];
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { id } = (args ?? {}) as { id?: string };
    switch (command) {
      case "automation_run_list_for_ticket":
        return runs;
      case "automation_run_dismiss":
      case "automation_run_again":
        runs = runs.map((run) =>
          run.id === id ? { ...run, needs_you: false } : run,
        );
        return undefined;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

/** What the ticket page shows of a ticket's runs: the notices, then the rail section. */
function Ticket() {
  const ticketRuns = useTicketRuns("T-ZB8", true);
  return (
    <>
      <RunNotices {...ticketRuns} />
      <TicketRunsSection runs={ticketRuns.runs} />
    </>
  );
}
const openRun = vi.fn();
const ticket = (chat = true) =>
  render(
    <WorkspaceChangeProvider value={0}>
      <ChatFeatureContext
        value={{
          enabled: chat,
          setEnabled: async () => {},
          overview: { needs_you: 0, working: 0 },
          revision: 0,
        }}
      >
        <RunNavigation value={openRun}>
          <Ticket />
        </RunNavigation>
      </ChatFeatureContext>
    </WorkspaceChangeProvider>,
  );

test("a ticket with no runs has no Runs section and no notice", async () => {
  runs = [];
  ticket();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("automation_run_list_for_ticket", {
      reference: "T-ZB8",
    }),
  );
  expect(screen.queryByRole("region")).toBeNull();
  expect(screen.queryByText("Runs")).toBeNull();
});

test("the Runs section lists the ticket's runs with how each ended, and opens one", async () => {
  runs = [ticketRun({ id: "run-2" }), FAILED];
  ticket();

  const section = await screen.findByRole("region", { name: "Runs" });
  const rows = within(section).getAllByRole("button");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Triage new ticketsCompleted · now",
    "Triage new ticketsNeeds attention · now",
  ]);
  fireEvent.click(rows[0]!);
  expect(openRun).toHaveBeenCalledWith("run-2");
});

test("a run that needs attention puts a notice on the ticket, and opening the run leaves it there", async () => {
  runs = [FAILED];
  ticket();

  const notice = await screen.findByRole("region", {
    name: "Triage new tickets needs attention",
  });
  expect(notice.textContent).toContain(LIMIT);
  fireEvent.click(within(notice).getByRole("button", { name: "Open run" }));
  expect(openRun).toHaveBeenCalledWith("run-1");
  expect(
    screen.getByRole("region", { name: "Triage new tickets needs attention" }),
  ).toBeTruthy();
});

test.each([
  ["Dismiss", "automation_run_dismiss"],
  ["Run again", "automation_run_again"],
])(
  "%s clears the notice and keeps the run in the section",
  async (name, command) => {
    runs = [FAILED];
    ticket();
    const notice = await screen.findByRole("region", {
      name: "Triage new tickets needs attention",
    });

    fireEvent.click(within(notice).getByRole("button", { name }));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Triage new tickets needs attention",
        }),
      ).toBeNull(),
    );
    expect(invoke).toHaveBeenCalledWith(command, { id: "run-1" });
    expect(
      within(screen.getByRole("region", { name: "Runs" })).getByRole("button")
        .textContent,
    ).toBe("Triage new ticketsNeeds attention · now");
  },
);

test("while Chat is off, a ticket shows nothing about runs", async () => {
  runs = [FAILED];
  ticket(false);
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole("region")).toBeNull();
});
