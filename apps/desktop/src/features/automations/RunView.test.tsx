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
import { createMockChatClient } from "@/features/chats/mock-client";
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
      yes: [{ id: "tell-me", kind: "notify" }],
      no: [{ id: "send-back", kind: "change_ticket" }],
    },
  ],
  enabled: true,
  arrived_off: false,
  problems: [],
};
const run = (patch: Partial<AutomationRunDetail>): AutomationRunDetail => ({
  id: "run-1",
  automation_id: VERIFY.id,
  status: "running",
  reason: null,
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

const chat = createMockChatClient();
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
  await screen.findByRole("application", { name: "Steps" });
  return view;
};
const cards = () =>
  within(screen.getByRole("application", { name: "Steps" }))
    .getAllByRole("button")
    .map((button) =>
      // What a Notify me or Change ticket card says is not this view's to decide.
      button
        .getAttribute("aria-label")
        ?.replace(/^(Notify me|Change ticket): .*, /, "$1, "),
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
    "Run agent: Verifier, Failed",
    "If: Ticket has tag verified, Not run",
    "Notify me, Not run",
    "Change ticket, Not run",
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
  expect(cards()[1]).toBe("Run agent: Verifier, Waiting");
  expect(invoke).toHaveBeenCalledWith("automation_run_again", { id: "run-1" });
});

test("a run in progress follows the Workspace as it goes, and Stop ends it needing attention", async () => {
  runs = [run({ steps: [reached("verify", "running")] })];
  const view = await openRun();
  expect(screen.getByRole("status").textContent).toBe("Running");
  expect(cards().slice(1, 3)).toEqual([
    "Run agent: Verifier, Running",
    "If: Ticket has tag verified, Waiting",
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
    "Run agent: Verifier, Completed",
    "If: Ticket has tag verified, Completed",
    "Notify me, Not run",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));

  await screen.findByRole("button", { name: "Run again" });
  expect(screen.getByRole("status").textContent).toBe("Needs attention");
  expect(invoke).toHaveBeenCalledWith("automation_run_stop", { id: "run-1" });
});
