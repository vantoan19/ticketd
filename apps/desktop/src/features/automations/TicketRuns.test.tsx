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
  answer: null,
  automation_deleted: false,
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
          run.id === id
            ? {
                ...run,
                needs_you: false,
                answer:
                  command === "automation_run_again"
                    ? "ran_again"
                    : "dismissed",
              }
            : run,
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
          overview: { needs_you: 0, unread: 0, app_icon: 0, working: 0 },
          revision: 0,
          openRequest: null,
          chatRequest: null,
          requestChat: () => {},
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

test("a run whose Automation was deleted says so in its notice and cannot be run again", async () => {
  runs = [{ ...FAILED, automation_deleted: true }];
  ticket();

  const notice = await screen.findByRole("region", {
    name: "Triage new tickets needs attention",
  });
  expect(notice.textContent).toContain(`${LIMIT} Its Automation was deleted.`);
  expect(
    within(notice).queryByRole("button", { name: "Run again" }),
  ).toBeNull();
  expect(within(notice).getByRole("button", { name: "Dismiss" })).toBeTruthy();
});

test.each([
  ["Dismiss", "automation_run_dismiss", "dismissed"],
  ["Run again", "automation_run_again", "run again"],
])(
  "%s clears the notice and keeps the run in the section, saying how it was answered",
  async (name, command, how) => {
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
    ).toBe(`Triage new ticketsNeeds attention · ${how} · now`);
  },
);

test("while Chat is off, a run that needs attention keeps its notice with Dismiss only, and the Runs section is hidden", async () => {
  runs = [FAILED];
  ticket(false);

  const notice = await screen.findByRole("region", {
    name: "Triage new tickets needs attention",
  });
  expect(notice.textContent).toContain("Turn Chat on to open this run.");
  expect(
    within(notice)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Dismiss"]);
  expect(screen.queryByRole("region", { name: "Runs" })).toBeNull();

  fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", {
        name: "Triage new tickets needs attention",
      }),
    ).toBeNull(),
  );
});

test("each notice says when its run started, and past two the rest fold into one line", async () => {
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  runs = [
    { ...FAILED, id: "run-3", created_at: minutesAgo(5) },
    { ...FAILED, id: "run-2", created_at: minutesAgo(12) },
    { ...FAILED, id: "run-1", created_at: minutesAgo(30) },
  ];
  ticket();

  const notices = () =>
    screen.queryAllByRole("region", {
      name: "Triage new tickets needs attention",
    });
  await waitFor(() => expect(notices()).toHaveLength(2));
  expect(
    notices().map(
      (notice) => notice.querySelector("[data-slot=alert-title]")?.textContent,
    ),
  ).toEqual([
    "Triage new tickets needs attention · 5m",
    "Triage new tickets needs attention · 12m",
  ]);

  fireEvent.click(
    screen.getByRole("button", {
      name: "Show 1 more run that needs attention",
    }),
  );
  expect(notices()).toHaveLength(3);
});

test("a failed read of the ticket's runs stops showing once a later read works", async () => {
  runs = [];
  vi.mocked(invoke).mockRejectedValueOnce(new Error("the workspace is busy"));
  const page = (version: number) => (
    <WorkspaceChangeProvider value={version}>
      <ChatFeatureContext
        value={{
          enabled: true,
          setEnabled: async () => {},
          overview: { needs_you: 0, unread: 0, app_icon: 0, working: 0 },
          revision: 0,
          openRequest: null,
          chatRequest: null,
          requestChat: () => {},
        }}
      >
        <Ticket />
      </ChatFeatureContext>
    </WorkspaceChangeProvider>
  );
  const view = render(page(0));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The workspace is busy",
  );

  // The Workspace changes, the runs are read again, and this time it works.
  view.rerender(page(1));

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
