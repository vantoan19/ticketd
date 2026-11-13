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
import type { AutomationAgent } from "@/features/automations/client";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const DEFAULTS = {
  name: "",
  harness: "claude-code",
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
} as const;

/** The agents the fake Workspace holds, changed by the same commands the page sends. */
let stored: AutomationAgent[] = [];
beforeEach(() => {
  stored = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { id, settings } = (args ?? {}) as {
      id?: string;
      settings?: AutomationAgent;
    };
    switch (command) {
      case "automation_agent_list":
        return stored;
      case "automation_agent_create": {
        const agent = { id: `agent-${stored.length + 1}`, ...DEFAULTS };
        stored = [agent as unknown as AutomationAgent, ...stored];
        return agent;
      }
      case "automation_agent_update": {
        const agent = { ...settings, id } as AutomationAgent;
        stored = stored.map((item) => (item.id === id ? agent : item));
        return agent;
      }
      case "automation_agent_delete":
        stored = stored.filter((item) => item.id !== id);
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

const open = async (
  harnesses = createMockChatClient(),
  agents: AutomationAgent[] = [],
) => {
  stored = agents;
  render(
    <ChatClientContext value={harnesses}>
      <AutomationsView />
    </ChatClientContext>,
  );
  fireEvent.click(screen.getByRole("radio", { name: /^Agents/ }));
  await screen.findByRole("list", { name: "Agents" });
};

test("the Agents list starts empty, explains what an agent is, and New agent opens one with the defaults", async () => {
  await open();
  expect(screen.getByText("An agent is who a step runs")).toBeTruthy();

  fireEvent.click(screen.getAllByRole("button", { name: "New agent" })[0]!);

  const form = await screen.findByRole("region", { name: "New agent" });
  const field = (name: string) =>
    within(form).getByRole("textbox", { name }) as HTMLInputElement;
  expect(field("Name").value).toBe("");
  expect(
    within(form)
      .getByRole("radio", { name: /Claude Code/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    (
      within(form).getByRole("spinbutton", {
        name: "Turns",
      }) as HTMLInputElement
    ).value,
  ).toBe("40");
  expect(
    (
      within(form).getByRole("spinbutton", {
        name: "Minutes",
      }) as HTMLInputElement
    ).value,
  ).toBe("20");
  expect(
    within(form)
      .getByRole("switch", { name: "Read files" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(within(form).getByText("ticketd command line")).toBeTruthy();
  expect(within(form).getByText("Always allowed")).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "Agents" })).getByRole("button", {
      name: /New agent/,
    }),
  ).toBeTruthy();
});

test("a harness that is not installed says so and cannot be chosen", async () => {
  const client = createMockChatClient({
    harnesses: [
      { id: "claude-code", name: "Claude Code", status: "ready" },
      { id: "codex", name: "Codex", status: "not_installed" },
    ],
  });
  await open(client, [
    { id: "a1", ...DEFAULTS, name: "Triage" } as unknown as AutomationAgent,
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Triage/ }));

  const codex = (await screen.findByRole("radio", {
    name: /Codex/,
  })) as HTMLButtonElement;
  await waitFor(() => expect(codex.textContent).toContain("Not installed"));
  expect(codex.disabled).toBe(true);
  expect(
    screen.getByRole("radio", { name: /Claude Code/ }).textContent,
  ).toContain("Ready");
  fireEvent.click(codex);
  expect(stored[0]?.harness).toBe("claude-code");
});

test("an edit is saved as it is made and shows in the list", async () => {
  await open(undefined, [
    { id: "a1", ...DEFAULTS, name: "Triage" } as unknown as AutomationAgent,
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
  const form = await screen.findByRole("region", { name: "Triage" });

  fireEvent.change(within(form).getByRole("textbox", { name: "Name" }), {
    target: { value: "Verifier" },
  });
  fireEvent.click(within(form).getByRole("switch", { name: "Run commands" }));
  fireEvent.change(
    within(form).getByRole("textbox", { name: "Allowed commands" }),
    { target: { value: "npm test\nnpm run lint\n" } },
  );
  fireEvent.change(within(form).getByRole("spinbutton", { name: "Turns" }), {
    target: { value: "12" },
  });

  await waitFor(() =>
    expect(stored[0]).toMatchObject({
      id: "a1",
      name: "Verifier",
      turn_limit: 12,
      tools: {
        run_commands: true,
        allowed_commands: ["npm test", "npm run lint"],
      },
    }),
  );
  expect(
    within(screen.getByRole("list", { name: "Agents" })).getByRole("button", {
      name: /Verifier/,
    }),
  ).toBeTruthy();
});

test("deleting an agent asks first, then removes it from the list", async () => {
  await open(undefined, [
    { id: "a1", ...DEFAULTS, name: "Triage" } as unknown as AutomationAgent,
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
  await screen.findByRole("region", { name: "Triage" });

  fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));
  expect(stored).toHaveLength(1);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
  );

  await waitFor(() => expect(stored).toHaveLength(0));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Triage" })).toBeNull(),
  );
  expect(screen.getByText("An agent is who a step runs")).toBeTruthy();
});
