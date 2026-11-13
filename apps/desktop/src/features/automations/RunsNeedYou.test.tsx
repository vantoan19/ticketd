// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";
import { summarize } from "@/features/tickets/inboxModel";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

const LIMIT = "The agent reached its limit of 40 turns before finishing.";
const TRIAGE = {
  id: "automation-1",
  name: "Triage new tickets",
  trigger: { kind: "tag_added", tag: "ready-for-triage" },
  conditions: [],
  steps: [
    {
      id: "triage",
      kind: "run_agent",
      agent_id: "agent-1",
      execution_folder: "C:\\code\\web-app",
    },
  ],
};
const ENTRY = {
  id: 7,
  reference: "T-ZB8",
  title: "Login form flickers in Safari",
  kind: "automation_run",
  from_value: "run-1",
  to_value: LIMIT,
  timestamp: new Date().toISOString(),
  read: false,
  editing_agent: "Triage new tickets",
};
/** How many runs the fake Workspace says need the person. */
let waiting = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: never) => {
    switch (command) {
      case "workspace_change_token":
        return 1;
      case "find_tickets_with_updates":
        return [];
      case "sidebar_counts":
        return {
          unread_inbox: 1,
          ready: 0,
          in_progress: 0,
          runs_needing_you: waiting,
        };
      case "inbox":
        return [ENTRY];
      case "set_inbox_read":
        return undefined;
      case "automation_list":
        return [{ ...TRIAGE, enabled: true, arrived_off: false, problems: [] }];
      case "automation_run_get":
        return {
          id: "run-1",
          automation_id: TRIAGE.id,
          status: "needs_attention",
          reason: LIMIT,
          needs_you: true,
          ticket: { id: "t-8", reference: "T-ZB8", title: ENTRY.title },
          created_at: ENTRY.timestamp,
          started_at: ENTRY.timestamp,
          ended_at: ENTRY.timestamp,
          definition: TRIAGE,
          steps: [],
        };
      default:
        return bridgeDefault(command, args);
    }
  },
}));
vi.mock("@/features/tickets/DependencyGraph", () => ({ default: () => null }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  expect(unknownCommands).toEqual([]);
});

const app = () =>
  render(
    <ChatClientContext value={createMockChatClient({ enabled: true })}>
      <App />
    </ChatClientContext>,
  );

test.each([
  [0, "Automations"],
  [1, "Automations · 1 run needs you"],
  [3, "Automations · 3 runs need you"],
])(
  "with %i runs needing attention the sidebar entry is named %s",
  async (count, name) => {
    waiting = count;
    app();
    const entry = await screen.findByRole("button", { name });
    // The count sits beside the entry, as it does on Chats.
    expect(entry.textContent?.trim()).toBe(
      count ? `Automations${count}` : "Automations",
    );
  },
);

test("an Inbox entry for a run that needs attention says which Automation and why, and opens the run", async () => {
  waiting = 1;
  app();
  fireEvent.click(await screen.findByRole("button", { name: /^Inbox/ }));
  const entry = await screen.findByText(
    `Triage new tickets needs attention: ${LIMIT}`,
  );

  fireEvent.click(entry);

  const heading = await screen.findByText("Run on T-ZB8");
  expect(heading.textContent).toBe("Triage new tickets › Run on T-ZB8");
  // Reading the entry and opening the run is not acting on it.
  expect(
    screen.getByRole("button", { name: "Automations · 1 run needs you" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: /^Automations/ })
      .getAttribute("aria-current"),
  ).toBe("page");
});

test("an Inbox entry for a run without a reason or a name still reads as a sentence", () => {
  expect(
    summarize({ ...ENTRY, to_value: "", editing_agent: null, deleted: false }),
  ).toBe("An Automation needs attention");
});
