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
import { AutomationsView } from "@/features/automations/AutomationsView";
import type {
  Automation,
  AutomationAgent,
  AutomationRunDetail,
} from "@/features/automations/client";
import { ChatClientContext } from "@/features/chats/client";
import { chatState, createMockChatClient } from "@/features/chats/mock-client";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

const VERIFIER: AutomationAgent = {
  id: "agent-1",
  name: "Verifier",
  harness: "codex",
  model: null,
  instructions: "",
  tools: {
    read_files: true,
    edit_files: false,
    run_commands: false,
    any_command: false,
    allowed_commands: [],
    use_web: false,
  },
  turn_limit: 40,
  time_limit_minutes: 20,
  used_by: [],
};
/** An agent step, then an If with a step on each path. */
const VERIFY: Automation = {
  id: "automation-1",
  name: "Verify on staging",
  trigger: { kind: "tag_added", tag: "ready-for-testing" },
  conditions: [],
  steps: [
    {
      id: "verify",
      kind: "run_agent",
      agent_id: "agent-1",
      execution_folder: "C:\\code\\web-app",
      on_failure: null,
    },
    {
      id: "passed",
      kind: "if",
      checks: [{ kind: "tag", tag: "verified", has: true }],
      yes: [
        {
          id: "tell-me",
          kind: "notify",
          text: "Verified {{ticket.reference}}",
          opens: "run",
        },
      ],
      no: [
        {
          id: "send-back",
          kind: "change_ticket",
          change: { action: "add_tag", tag: "needs-fix" },
        },
      ],
    },
  ],
  enabled: true,
  arrived_off: false,
  problems: [],
  has_ticket: true,
};
const run = (patch: Partial<AutomationRunDetail>): AutomationRunDetail => ({
  id: "run-1",
  automation_id: VERIFY.id,
  status: "running",
  reason: null,
  needs_you: false,
  ticket: { id: "t-1", reference: "T-ZB7", title: "Show the wait time" },
  created_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  ended_at: null,
  definition: {
    name: VERIFY.name,
    trigger: VERIFY.trigger,
    conditions: [],
    steps: VERIFY.steps,
  },
  steps: [],
  ...patch,
});
const reached = (
  step_id: string,
  status: "running" | "completed" | "failed",
  reason: string | null = null,
) => ({
  step_id,
  status,
  reason,
  chat_id: step_id === "verify" ? "chat-1" : null,
  chat_owned: step_id === "verify",
  started_at: new Date().toISOString(),
  ended_at: null,
});

/** The fake Workspace's runs, newest first, changed by the commands the page sends. */
let runs: AutomationRunDetail[] = [];
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { id } = (args ?? {}) as { id?: string };
    const found = runs.find((item) => item.id === id);
    switch (command) {
      case "automation_list":
        return [VERIFY];
      case "automation_run_list_all":
        return [];
      case "automation_agent_list":
        return [VERIFIER];
      case "automation_run_list":
        return runs;
      case "automation_run_get":
        return found;
      case "automation_run_stop":
        runs = runs.map((item) =>
          item.id === id
            ? { ...item, status: "needs_attention", reason: "You stopped it." }
            : item,
        );
        return runs.find((item) => item.id === id);
      case "automation_run_again": {
        const again = run({ id: "run-2", status: "queued", started_at: null });
        runs = [again, ...runs];
        return again;
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

const chat = createMockChatClient({
  enabled: true,
  chats: [{ chat: chatState({ id: "chat-1", title: "Verify T-ZB7" }) }],
});
const page = (version: number) => (
  <WorkspaceChangeProvider value={version}>
    <ChatClientContext value={chat}>
      <AutomationsView />
    </ChatClientContext>
  </WorkspaceChangeProvider>
);
/** Opens the Automation's newest run from its Runs list. */
const openRun = async () => {
  const view = render(page(0));
  const rows = await screen.findByRole("list", { name: "Automations" });
  fireEvent.click(await within(rows).findByRole("button"));
  // The list header has a Runs view too; the second is the Automation's own.
  fireEvent.click((await screen.findAllByRole("radio", { name: "Runs" }))[1]!);
  const today = await screen.findByRole("list", { name: "Runs, Today" });
  fireEvent.click(within(today).getAllByRole("button")[0]!);
  const steps = await screen.findByRole("application", { name: "Steps" });
  // The canvas draws its cards a moment after it appears.
  await within(steps).findAllByRole("button");
  return view;
};
const cards = () =>
  within(screen.getByRole("application", { name: "Steps" }))
    .getAllByRole("button")
    .map((button) =>
      // What a Notify me or Change ticket card says is not this view's to decide.
      button
        .getAttribute("aria-label")
        ?.replace(/^(Notify me|Change ticket): [^,]*, /, "$1, "),
    );

test("a run that needs attention opens on the canvas with each step's status and why it failed, and can be run again", async () => {
  runs = [
    run({
      status: "needs_attention",
      reason: "The agent reached its limit of 40 turns before finishing.",
      ended_at: new Date().toISOString(),
      steps: [
        reached(
          "verify",
          "failed",
          "The agent reached its limit of 40 turns before finishing.",
        ),
      ],
    }),
  ];
  await openRun();

  // Every step of the run's definition, in run order; nothing can be added.
  expect(cards()).toEqual([
    "When a tag is added: ready-for-testing",
    "Run agent: Verifier, step 1 of 2, Failed",
    "If: Ticket has tag verified, step 2 of 2, Not run",
    "Notify me, Yes path, step 1 of 1, Not run",
    "Change ticket, No path, step 1 of 1, Not run",
  ]);
  expect(screen.getByRole("status").textContent).toBe("Needs attention");
  // It opens on the step that failed: why, and the agent's Chat.
  const panel = screen.getByRole("complementary", { name: "Run agent" });
  expect(panel.textContent).toContain(
    "The agent reached its limit of 40 turns before finishing.",
  );
  expect(within(panel).getByRole("button", { name: "Open Chat" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Run again" }));

  // The new run opens: queued, from the first step.
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Queued"),
  );
  // The canvas draws its cards a moment after the run loads.
  await waitFor(() =>
    expect(cards()[1]).toBe("Run agent: Verifier, step 1 of 2, Waiting"),
  );
  expect(invoke).toHaveBeenCalledWith("automation_run_again", { id: "run-1" });
});

test("a run in progress follows the Workspace as it goes, and Stop ends it needing attention", async () => {
  runs = [run({ steps: [reached("verify", "running")] })];
  const view = await openRun();
  expect(screen.getByRole("status").textContent).toBe("Running");
  expect(cards().slice(1, 3)).toEqual([
    "Run agent: Verifier, step 1 of 2, Running",
    "If: Ticket has tag verified, step 2 of 2, Waiting",
  ]);

  // The runner moves on; the page hears that the Workspace changed.
  runs = [
    run({
      steps: [
        reached("verify", "completed"),
        reached("passed", "completed"),
        reached("send-back", "running"),
      ],
    }),
  ];
  view.rerender(page(1));

  await screen.findByRole("button", { name: /^Change ticket: .*, Running$/ });
  // The path it did not take is settled, though the run is still going.
  expect(cards().slice(1, 4)).toEqual([
    "Run agent: Verifier, step 1 of 2, Completed",
    "If: Ticket has tag verified, step 2 of 2, Completed",
    "Notify me, Yes path, step 1 of 1, Not run",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));

  await screen.findByRole("button", { name: "Run again" });
  expect(screen.getByRole("status").textContent).toBe("Needs attention");
  expect(invoke).toHaveBeenCalledWith("automation_run_stop", { id: "run-1" });
});

test("a running step says once, where a screen reader hears it, that it finished or failed", async () => {
  runs = [run({ steps: [reached("verify", "running")] })];
  const view = await openRun();
  const said = () => document.querySelector("[aria-live=polite].sr-only");
  expect(said()?.textContent).toBe("");
  const steps = screen.getByRole("application", { name: "Steps" });
  const card = within(steps).getByRole("button", { name: /^Run agent/ });
  card.focus();

  runs = [
    run({
      steps: [reached("verify", "completed"), reached("passed", "running")],
    }),
  ];
  view.rerender(page(1));
  await waitFor(() =>
    expect(said()?.textContent).toBe("Run agent: Verifier finished"),
  );
  // Focus stays where the person left it.
  expect(document.activeElement).toBe(card);

  runs = [
    run({
      status: "needs_attention",
      steps: [
        reached("verify", "completed"),
        reached("passed", "failed", "The ticket is gone."),
      ],
    }),
  ];
  view.rerender(page(2));
  await waitFor(() =>
    expect(said()?.textContent).toBe("If: Ticket has tag verified failed"),
  );
});

test("a run whose failed step had a failure path is Completed, with the step Failed, its reason, and the path it took", async () => {
  const handled = (path: Automation["steps"]) =>
    run({
      status: "completed",
      ended_at: new Date().toISOString(),
      definition: {
        name: VERIFY.name,
        trigger: VERIFY.trigger,
        conditions: [],
        steps: [{ ...VERIFY.steps[0]!, on_failure: path }, VERIFY.steps[1]!],
      },
      steps: [
        reached("verify", "failed", "The agent reached its limit of 1 turns."),
        ...path.map((step) => reached(step.id, "completed")),
      ],
    });
  const WENT_ON = "The run went on down this step’s failure path.";
  runs = [
    handled([
      { id: "say-so", kind: "notify", text: "Not verified", opens: "run" },
    ]),
  ];
  const view = await openRun();

  expect(screen.getByRole("status").textContent).toBe("Completed");
  // The failure path follows its step; the steps after the one that failed did
  // not run.
  expect(cards().slice(1)).toEqual([
    "Run agent: Verifier, step 1 of 2, Failed",
    "Notify me, Failure path, step 1 of 1, Completed",
    "If: Ticket has tag verified, step 2 of 2, Not run",
    "Notify me, Yes path, step 1 of 1, Not run",
    "Change ticket, No path, step 1 of 1, Not run",
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: /^Run agent: Verifier, .*Failed$/ }),
  );
  const panel = screen.getByRole("complementary", { name: "Run agent" });
  expect(panel.textContent).toContain(
    "The agent reached its limit of 1 turns.",
  );
  expect(panel.textContent).toContain(WENT_ON);

  // A failure path with no steps handles the failure all the same.
  runs = [handled([])];
  view.rerender(page(1));
  await waitFor(() => expect(cards()).toHaveLength(5));
  expect(
    screen.getByRole("complementary", { name: "Run agent" }).textContent,
  ).toContain(WENT_ON);
});

const TAKE_OVER =
  "A run of Verify on staging. Reply to take it over; it moves to your Chats.";
const failedRun = (owned: boolean) =>
  run({
    status: owned ? "needs_attention" : "taken_over",
    needs_you: owned,
    ended_at: new Date().toISOString(),
    steps: [{ ...reached("verify", "failed", "Limit"), chat_owned: owned }],
  });

test("a run's Chat opens in the page and says above the composer that replying takes it over", async () => {
  runs = [failedRun(true)];
  const view = await openRun();

  fireEvent.click(screen.getByRole("button", { name: "Open Chat" }));

  expect(await screen.findByText(TAKE_OVER)).toBeTruthy();
  expect(screen.getByRole("textbox")).toBeTruthy();

  // The person replied: the Chat is theirs, and the line says where it came from.
  runs = [{ ...failedRun(false), status: "taken_over" }];
  view.rerender(page(1));
  await waitFor(() => expect(screen.queryByText(TAKE_OVER)).toBeNull());
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect(
    screen.getByText(
      /You took this over from a run of .+\. The run ended here\./,
    ),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "View run" }));
  await screen.findByRole("application", { name: "Steps" });
  expect(screen.getByRole("status").textContent).toBe("Taken over");
});
