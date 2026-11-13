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
  AutomationDefinition,
  AutomationRun,
} from "@/features/automations/client";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

const TRIAGE: AutomationAgent = {
  id: "agent-1",
  name: "Triage",
  harness: "claude-code",
  model: null,
  instructions: "",
  tools: {
    read_files: true,
    edit_files: false,
    run_commands: true,
    allowed_commands: ["npm test", "npm run lint"],
    use_web: false,
  },
  turn_limit: 40,
  time_limit_minutes: 20,
  used_by: [],
};
const runAgent = (id: string, agent: string | null, folder: string | null) => ({
  id,
  kind: "run_agent" as const,
  agent_id: agent,
  execution_folder: folder,
  on_failure: null,
});
const automation = (patch: Partial<Automation>): Automation => ({
  id: "automation-1",
  name: "",
  trigger: null,
  conditions: [],
  steps: [],
  enabled: false,
  problems: [],
  ...patch,
});

/** The fake Workspace, changed by the same commands the page sends. */
let automations: Automation[] = [];
let agents: AutomationAgent[] = [];
let runs: AutomationRun[] = [];
beforeEach(() => {
  automations = [];
  agents = [TRIAGE];
  runs = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { id, definition, enabled } = (args ?? {}) as {
      id?: string;
      definition?: AutomationDefinition;
      enabled?: boolean;
    };
    const change = (patch: Partial<Automation>) => {
      automations = automations.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      );
      return automations.find((item) => item.id === id);
    };
    switch (command) {
      case "automation_list":
        return automations;
      case "automation_agent_list":
        return agents;
      case "automation_run_list":
        return runs;
      case "automation_create": {
        const created = automation({ id: `automation-${automations.length}` });
        automations = [created, ...automations];
        return created;
      }
      case "automation_update":
        return change(definition ?? {});
      case "automation_set_enabled":
        return change({ enabled: enabled ?? false });
      case "automation_delete":
        automations = automations.filter((item) => item.id !== id);
        return null;
      case "automation_agent_create": {
        const agent = { ...TRIAGE, id: "agent-new", name: "" };
        agents = [agent, ...agents];
        return agent;
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

const chat = createMockChatClient();
const open = async (stored: Automation[] = []) => {
  automations = stored;
  render(
    <ChatClientContext value={chat}>
      <AutomationsView />
    </ChatClientContext>,
  );
  await screen.findByRole("list", { name: "Automations" });
};
const openFirst = async (stored: Automation[]) => {
  await open(stored);
  const rows = screen.getByRole("list", { name: "Automations" });
  fireEvent.click(within(rows).getAllByRole("button")[0]!);
  return screen.findByRole("application", { name: "Steps" });
};
/** Opens the menu a button carries and chooses an item from it. */
const choose = async (button: HTMLElement, item: RegExp) => {
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
};
const cardNames = (steps: HTMLElement) =>
  within(steps)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"))
    .filter((name) => name && !/actions$|^Change what/.test(name));

test("a simple Automation is built from a trigger card and one +, each set up in the panel beside the canvas", async () => {
  chat.nextFolder = "C:\\code\\web-app";
  await open();
  fireEvent.click(
    screen.getAllByRole("button", { name: "New Automation" })[0]!,
  );
  const steps = await screen.findByRole("application", { name: "Steps" });

  // Nothing but the trigger card and one +.
  expect(cardNames(steps)).toEqual([
    "Trigger: Choose what starts it",
    "Add a step after Trigger: Choose what starts it",
  ]);
  expect(screen.queryByRole("complementary")).toBeNull();

  // The trigger is chosen from a menu on its card, then set up in the panel.
  await choose(
    within(steps).getByRole("button", { name: /^Trigger:/ }),
    /Tag added/,
  );
  const tagPanel = await screen.findByRole("complementary", {
    name: "When a tag is added",
  });
  fireEvent.change(within(tagPanel).getByRole("textbox", { name: "Tag" }), {
    target: { value: "Ready-For-Triage" },
  });
  await within(steps).findByRole("button", {
    name: "When a tag is added: ready-for-triage",
  });

  // The step kind is chosen from a menu on the +.
  await choose(
    within(steps).getByRole("button", { name: /^Add a step after/ }),
    /Run agent/,
  );
  const stepPanel = await screen.findByRole("complementary", {
    name: "Run agent",
  });
  await choose(
    within(stepPanel).getByRole("button", { name: "Agent" }),
    /Triage/,
  );
  // The panel says what the chosen agent may do.
  expect(
    await within(stepPanel).findByText(
      /Claude Code\. Can read files and run 2 commands, and use the ticketd command line\./,
    ),
  ).toBeTruthy();
  fireEvent.click(within(stepPanel).getByRole("button", { name: "Folder" }));

  await waitFor(() =>
    expect(automations[0]).toMatchObject({
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [
        {
          kind: "run_agent",
          agent_id: "agent-1",
          execution_folder: "C:\\code\\web-app",
        },
      ],
    }),
  );
  expect(
    within(steps).getByRole("button", { name: "Run agent: Triage" })
      .textContent,
  ).toContain("Claude Code · in web-app");
});

test("a Run agent step can make a new agent without leaving the editor", async () => {
  const steps = await openFirst([
    automation({ steps: [runAgent("s1", null, null)] }),
  ]);
  fireEvent.click(
    within(steps).getByRole("button", { name: "Run agent: Choose an agent" }),
  );
  const panel = await screen.findByRole("complementary", { name: "Run agent" });

  await choose(
    within(panel).getByRole("button", { name: "Agent" }),
    /New agent/,
  );

  // The agent's form opens over the editor, and the step already runs it.
  const form = await screen.findByRole("region", { name: "New agent" });
  expect(within(form).getByRole("textbox", { name: "Name" })).toBeTruthy();
  await waitFor(() =>
    expect(automations[0]?.steps[0]).toMatchObject({ agent_id: "agent-new" }),
  );
});

test("the + on a line is in the Tab order between the two cards it joins, and the path ends with a +", async () => {
  const steps = await openFirst([
    automation({
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [runAgent("s1", "agent-1", "C:\\code\\web-app")],
    }),
  ]);

  expect(cardNames(steps)).toEqual([
    "When a tag is added: ready-for-triage",
    "Add a step after When a tag is added: ready-for-triage",
    "Run agent: Triage",
    "Add a step after Run agent: Triage",
  ]);
  // Every one is a real button, reached by Tab.
  for (const button of within(steps).getAllByRole("button"))
    expect(button.tabIndex).toBe(0);
});

test("an unfinished step says what it needs and the Automation cannot be switched on; a finished one can", async () => {
  const steps = await openFirst([
    automation({
      name: "Unfinished",
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [runAgent("s1", null, null)],
      problems: [{ step_id: "s1", message: "Needs an agent and a folder" }],
    }),
    automation({
      id: "automation-2",
      name: "Finished",
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [runAgent("s2", "agent-1", "C:\\code")],
    }),
  ]);

  expect(
    within(steps).getByRole("button", { name: "Run agent: Choose an agent" })
      .textContent,
  ).toContain("Needs an agent and a folder");
  expect(screen.getByText("1 step left")).toBeTruthy();
  const off = screen.getByRole("switch", {
    name: "On for this desktop",
  }) as HTMLButtonElement;
  expect(off.disabled).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: /Finished/ }));
  await screen.findByRole("heading", { name: "Finished" });
  expect(screen.queryByText(/left$/)).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "On for this desktop" }));

  await waitFor(() => expect(automations[1]?.enabled).toBe(true));
  await waitFor(() =>
    expect(
      screen
        .getByRole("switch", { name: "On for this desktop" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("a list row shows the name, On or Off, and the tag that starts it; a row that is off is muted", async () => {
  await open([
    automation({
      name: "Triage new tickets",
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      enabled: true,
    }),
    automation({ id: "automation-2" }),
  ]);

  const [on, off] = within(
    screen.getByRole("list", { name: "Automations" }),
  ).getAllByRole("button");
  expect(on?.textContent).toBe("Triage new ticketsOnready-for-triage");
  expect(on?.hasAttribute("data-off")).toBe(false);
  expect(off?.textContent).toBe("New AutomationOffno trigger yet");
  expect(off?.hasAttribute("data-off")).toBe(true);
});

test("an Automation is renamed and deleted from its menu, and a step is deleted from its own", async () => {
  const steps = await openFirst([
    automation({
      name: "Triage",
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [runAgent("s1", "agent-1", "C:\\code")],
    }),
  ]);
  const actions = () =>
    screen.getByRole("button", { name: "Automation actions" });

  await choose(actions(), /Rename/);
  const rename = await screen.findByRole("dialog");
  fireEvent.change(within(rename).getByRole("textbox", { name: "Name" }), {
    target: { value: "Triage new tickets" },
  });
  fireEvent.click(within(rename).getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(automations[0]?.name).toBe("Triage new tickets"));
  await screen.findByRole("heading", { name: "Triage new tickets" });

  await choose(
    within(steps).getByRole("button", { name: "Step actions" }),
    /Delete step/,
  );
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(automations[0]?.steps).toEqual([]));
  expect(
    within(steps).queryByRole("button", { name: "Run agent: Triage" }),
  ).toBeNull();

  await choose(actions(), /Delete/);
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(automations).toEqual([]));
  await waitFor(() =>
    expect(screen.queryByRole("application", { name: "Steps" })).toBeNull(),
  );
});

test("an agent used by a step cannot be deleted, and its menu names the Automation", async () => {
  agents = [{ ...TRIAGE, used_by: ["Triage new tickets"] }];
  await open();
  fireEvent.click(screen.getByRole("radio", { name: /^Agents/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Triage/ }));
  await screen.findByRole("region", { name: "Triage" });

  fireEvent.keyDown(screen.getByRole("button", { name: "Agent actions" }), {
    key: "Enter",
  });

  const item = await screen.findByRole("menuitem", { name: /Delete/ });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toContain(
    "Used by Triage new tickets. Change that step first.",
  );
});

const TRIAGE_TAGGED = automation({
  name: "Triage new tickets",
  trigger: { kind: "tag_added", tag: "ready-for-triage" },
  steps: [runAgent("step-1", "agent-1", "C:\\code\\web-app")],
  enabled: true,
});

test("the Runs view lists the Automation's runs by day, each with its ticket, status and time", async () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  runs = [
    {
      id: "run-2",
      status: "needs_attention",
      reason: "The agent reached its limit of 40 turns before finishing.",
      ticket: { id: "t-2", reference: "T-ZB8", title: "Login form flickers" },
      created_at: ago(0),
    },
    {
      id: "run-1",
      status: "completed",
      reason: null,
      ticket: { id: "t-1", reference: "T-ZB4", title: "Add a logout endpoint" },
      created_at: ago(5 * 86_400_000),
    },
  ];
  await openFirst([TRIAGE_TAGGED]);

  fireEvent.click(screen.getByRole("radio", { name: "Runs" }));

  const today = await screen.findByRole("list", { name: "Runs, Today" });
  expect(screen.queryByRole("application", { name: "Steps" })).toBeNull();
  expect(within(today).getAllByRole("listitem")).toHaveLength(1);
  const latest = within(today).getByRole("listitem");
  expect(latest.textContent).toContain("T-ZB8 Login form flickers");
  expect(latest.textContent).toContain("Needs attention");
  expect(latest.textContent).toContain(
    "The agent reached its limit of 40 turns before finishing.",
  );
  expect(within(latest).getByText("now")).toBeTruthy();

  // The older run sits under its own day.
  const lists = screen.getAllByRole("list", { name: /^Runs, / });
  expect(lists).toHaveLength(2);
  expect(lists[1]!.textContent).toContain("T-ZB4 Add a logout endpoint");
  expect(lists[1]!.textContent).toContain("Completed");

  // Back to the flow.
  fireEvent.click(screen.getByRole("radio", { name: "Steps" }));
  await screen.findByRole("application", { name: "Steps" });
});

test("an Automation that has not run yet says so", async () => {
  await openFirst([TRIAGE_TAGGED]);

  fireEvent.click(screen.getByRole("radio", { name: "Runs" }));

  await screen.findByText("No runs yet");
  expect(
    screen.getByText(
      "It runs the next time a ticket is tagged ready-for-triage.",
    ),
  ).toBeTruthy();
});
