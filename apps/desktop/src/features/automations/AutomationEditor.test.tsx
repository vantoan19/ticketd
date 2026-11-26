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
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import type { Project } from "@/lib/api/client";
import { selectAutomationView } from "@/test/automation-navigation";

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
    any_command: false,
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
  arrived_off: false,
  problems: [],
  has_ticket: true,
  ...patch,
});

/** The fake Workspace, changed by the same commands the page sends. */
let automations: Automation[] = [];
let agents: AutomationAgent[] = [];
let runs: AutomationRun[] = [];
/** Every run, for the page's list of them. */
let allRuns: (AutomationRun & { automation_name: string })[] = [];
let projects: Project[] = [];
beforeEach(() => {
  automations = [];
  agents = [TRIAGE];
  runs = [];
  allRuns = [];
  projects = [];
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
      case "automation_run_list_all":
        return allRuns;
      case "automation_agent_list":
        return agents;
      case "list_projects":
        return projects;
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
        return change({ enabled: enabled ?? false, arrived_off: false });
      case "automation_stop_and_turn_off":
        runs = runs.map((run) => ({ ...run, status: "needs_attention" }));
        return change({ enabled: false });
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
  fireEvent.click((await within(rows).findAllByRole("button"))[0]!);
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
    .filter((name) => name && !/^Actions for |^Change what/.test(name));

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
  await choose(
    within(stepPanel).getByRole("button", { name: "Folder" }),
    /Choose a folder/,
  );

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
  await waitFor(() =>
    expect(
      within(steps).getByRole("button", { name: /^Run agent: Triage, / })
        .textContent,
    ).toContain("Claude Code · in web-app"),
  );
});

test("a Run agent step can make a new agent without leaving the editor", async () => {
  const steps = await openFirst([
    automation({ steps: [runAgent("s1", null, null)] }),
  ]);
  fireEvent.click(
    within(steps).getByRole("button", {
      name: /^Run agent: Choose an agent, /,
    }),
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

test("a Run agent step says when its agent's harness cannot run on this computer, and can still be switched on", async () => {
  chat.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "not_installed" },
    { id: "codex", name: "Codex", status: "ready" },
  ]);
  try {
    const steps = await openFirst([
      automation({
        trigger: { kind: "tag_added", tag: "bug" },
        steps: [runAgent("s1", "agent-1", "C:\\code\\web-app")],
      }),
    ]);
    fireEvent.click(
      within(steps).getByRole("button", { name: /^Run agent: Triage, / }),
    );
    const panel = await screen.findByRole("complementary", {
      name: "Run agent",
    });
    expect(
      await within(panel).findByText(
        "Claude Code is not installed on this computer, so this step cannot run here.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: /^On/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  } finally {
    chat.setHarnesses([
      { id: "claude-code", name: "Claude Code", status: "ready" },
      { id: "codex", name: "Codex", status: "ready" },
    ]);
  }
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
    "Run agent: Triage, step 1 of 1",
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
    within(steps).getByRole("button", { name: /^Run agent: Choose an agent, / })
      .textContent,
  ).toContain("Needs an agent and a folder");
  // The whole reason, where the card cuts it short.
  expect(
    within(steps)
      .getByRole("button", { name: /^Run agent: Choose an agent, / })
      .getAttribute("title"),
  ).toBe("Needs an agent and a folder");
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

const run = (patch: Partial<AutomationRun>): AutomationRun => ({
  id: "run-1",
  automation_id: "a2",
  status: "running",
  reason: null,
  needs_you: false,
  answer: null,
  automation_deleted: false,
  ticket: { id: "t1", reference: "T-ZB7", title: "Fix login" },
  created_at: "2026-11-14T09:00:00.000Z",
  ...patch,
});
const onSwitch = () =>
  screen.getByRole("switch", { name: "On for this desktop" });
const openRunning = async (active: AutomationRun[]) => {
  await openFirst([
    automation({
      name: "Triage",
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [runAgent("s1", "agent-1", "C:\\code")],
      enabled: true,
    }),
  ]);
  runs = active;
  fireEvent.click(onSwitch());
};
const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

test("switching off with no run in progress turns the Automation off without asking", async () => {
  await openRunning([run({ status: "completed" })]);

  await waitFor(() => expect(automations[0]?.enabled).toBe(false));
  expect(screen.queryByRole("menu")).toBeNull();
});

test("switching off mid-run asks, with turning off after the run finishes as the first choice", async () => {
  await openRunning([run({})]);

  const menu = await screen.findByRole("menu", { name: "Turn off" });
  expect(menu.textContent).toContain("A run is in progress");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Turn off after it finishesThe run on T-ZB7 completes; no new runs start",
    "Stop it and turn offThe run ends now as Needs attention",
    "Keep it on",
  ]);
  // Nothing has changed while the question is open.
  expect(automations[0]?.enabled).toBe(true);

  fireEvent.click(
    within(menu).getByRole("menuitem", { name: /Turn off after it finishes/ }),
  );

  await waitFor(() => expect(automations[0]?.enabled).toBe(false));
  expect(sent("automation_stop_and_turn_off")).toEqual([]);
  expect(runs[0]?.status).toBe("running");
});

test("Stop it and turn off ends the run and turns the Automation off", async () => {
  await openRunning([run({}), run({ id: "run-2", status: "queued" })]);

  const menu = await screen.findByRole("menu", { name: "Turn off" });
  expect(menu.textContent).toContain("2 runs are in progress");
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: /Stop them and turn off/ }),
  );

  await waitFor(() => expect(automations[0]?.enabled).toBe(false));
  expect(sent("automation_stop_and_turn_off")).toEqual([
    ["automation_stop_and_turn_off", { id: "automation-1" }],
  ]);
  expect(sent("automation_set_enabled")).toEqual([]);
  await waitFor(() =>
    expect(onSwitch().getAttribute("aria-checked")).toBe("false"),
  );
});

test("Keep it on leaves the Automation on and its run going", async () => {
  await openRunning([run({})]);

  fireEvent.click(await screen.findByRole("menuitem", { name: "Keep it on" }));

  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(automations[0]?.enabled).toBe(true);
  expect(sent("automation_set_enabled")).toEqual([]);
  expect(sent("automation_stop_and_turn_off")).toEqual([]);
  expect(onSwitch().getAttribute("aria-checked")).toBe("true");
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
    within(steps).getByRole("button", { name: /^Actions for / }),
    /Delete step/,
  );
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(automations[0]?.steps).toEqual([]));
  expect(
    within(steps).queryByRole("button", { name: /^Run agent: Triage, / }),
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

test("an Automation synced from another desktop is off here until it is turned on here", async () => {
  await openFirst([
    automation({
      name: "Weekly summary",
      trigger: { kind: "tag_added", tag: "summary" },
      steps: [runAgent("s1", "agent-1", "C:\\code\\web-app")],
      arrived_off: true,
    }),
    automation({ id: "automation-2", name: "Made here" }),
  ]);

  // The list says why it is off; one made on this desktop is only "Off".
  const rows = within(screen.getByRole("list", { name: "Automations" }));
  expect(
    rows.getByRole("button", { name: /Weekly summary/ }).textContent,
  ).toContain("Off on this desktop");
  expect(
    rows.getByRole("button", { name: /Made here/ }).textContent,
  ).not.toContain("Off on this desktop");

  const bar = screen.getByRole("status");
  expect(bar.textContent).toContain("Off on this desktop");
  fireEvent.click(within(bar).getByRole("button", { name: "Turn on here" }));

  await waitFor(() => expect(automations[0]?.enabled).toBe(true));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(
    screen
      .getByRole("switch", { name: "On for this desktop" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("an agent used by a step cannot be deleted, and its menu names the Automation", async () => {
  agents = [{ ...TRIAGE, used_by: ["Triage new tickets"] }];
  await open();
  await selectAutomationView("Agents");
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
      automation_id: "automation-1",
      status: "needs_attention",
      reason: "The agent reached its limit of 40 turns before finishing.",
      needs_you: true,
      answer: null,
      automation_deleted: false,
      ticket: { id: "t-2", reference: "T-ZB8", title: "Login form flickers" },
      created_at: ago(0),
    },
    {
      id: "run-1",
      automation_id: "automation-1",
      status: "completed",
      reason: null,
      needs_you: false,
      answer: null,
      automation_deleted: false,
      ticket: { id: "t-1", reference: "T-ZB4", title: "Add a logout endpoint" },
      created_at: ago(5 * 86_400_000),
    },
  ];
  await openFirst([TRIAGE_TAGGED]);

  // The Automation's Steps/Runs control opens its history.
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

  // The Automation's Steps/Runs control opens its history.
  fireEvent.click(screen.getByRole("radio", { name: "Runs" }));

  await screen.findByText("No runs yet");
  expect(
    screen.getByText(
      "It runs the next time a ticket is tagged ready-for-triage.",
    ),
  ).toBeTruthy();
});

test("Esc closes a step's panel and returns to the step, and Delete on the step asks before removing it with what is on its paths", async () => {
  const steps = await openFirst([
    automation({
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [
        {
          ...runAgent("s1", "agent-1", "C:\\code"),
          on_failure: [runAgent("s2", "agent-1", "C:\\code")],
        },
      ],
    }),
  ]);
  const card = within(steps).getAllByRole("button", {
    name: /^Run agent: Triage, /,
  })[0]!;

  // Enter on a card is a click on it: the panel opens and takes focus.
  fireEvent.click(card);
  const panel = await screen.findByRole("complementary", { name: "Run agent" });
  expect(document.activeElement).toBe(panel);
  // Enter again, from the card, goes back into the panel that is open.
  card.focus();
  fireEvent.click(card);
  expect(document.activeElement).toBe(panel);
  // The step is selected while its panel is open: Delete asks there too.
  fireEvent.keyDown(panel, { key: "Delete" });
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Delete step?" }),
    ).getByRole("button", { name: "Cancel" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(card);

  fireEvent.keyDown(card, { key: "Delete" });
  const dialog = await screen.findByRole("dialog", { name: "Delete step?" });
  // Nothing goes until the person says so.
  expect(automations[0]?.steps).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(automations[0]?.steps).toEqual([]));
});

test("deleting an Automation with a run in progress says the run is ended", async () => {
  await openRunning([]);
  await waitFor(() => expect(automations[0]?.enabled).toBe(false));
  runs = [run({})];

  await choose(
    screen.getByRole("button", { name: "Automation actions" }),
    /Delete/,
  );

  const dialog = await screen.findByRole("dialog", {
    name: "Delete Automation?",
  });
  expect(dialog.textContent).toContain("The run on T-ZB7 is ended now.");
});

test("the Runs switch of an Automation has the attention dot while one of its runs needs the person", async () => {
  allRuns = [
    {
      ...run({ automation_id: "automation-1", status: "needs_attention" }),
      needs_you: true,
      automation_name: "Triage",
    },
  ];
  await openFirst([
    automation({ name: "Triage", trigger: { kind: "by_hand" } }),
  ]);

  const show = screen.getAllByRole("radiogroup", { name: "Show" }).at(-1)!;
  expect(
    within(show).getByRole("radio", { name: "Runs , a run needs you" }),
  ).toBeTruthy();
});

test("a Run agent step's folder can be one of the projects' folders, or any folder", async () => {
  projects = [
    {
      id: "p1",
      name: "web-app",
      path: "\\\\?\\C:\\code\\web-app",
      // As the core gives it, with the verbatim prefix it is shown without.
      paths: ["\\\\?\\C:\\code\\web-app"],
    },
  ];
  await openFirst([
    automation({
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [runAgent("s1", "agent-1", null)],
    }),
  ]);
  fireEvent.click(screen.getByRole("button", { name: /^Run agent: Triage/ }));
  const panel = await screen.findByRole("complementary", { name: "Run agent" });

  const folder = within(panel).getByRole("button", { name: "Folder" });
  fireEvent.keyDown(folder, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["web-appC:\\code\\web-app", "Choose a folder…"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: /^web-app/ }));

  await waitFor(() =>
    expect(automations[0]?.steps).toMatchObject([
      { execution_folder: "C:\\code\\web-app" },
    ]),
  );
});

test("one Esc closes a step's panel from its Close button, though the button's tooltip takes the key too", async () => {
  await openFirst([
    automation({
      trigger: { kind: "tag_added", tag: "ready-for-triage" },
      steps: [runAgent("s1", "agent-1", null)],
    }),
  ]);
  fireEvent.click(screen.getByRole("button", { name: /^Run agent: Triage/ }));
  const panel = await screen.findByRole("complementary", { name: "Run agent" });
  const close = within(panel).getByRole("button", { name: "Close panel" });
  // As an open tooltip does: it handles Escape and marks it handled.
  close.addEventListener("keydown", (event) => event.preventDefault());

  fireEvent.keyDown(close, { key: "Escape" });

  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
});

test("an open Automation refreshes Project choices and keeps its saved archived condition", async () => {
  projects = [
    {
      id: "existing",
      name: "Existing",
      path: "/existing",
      paths: ["/existing"],
    },
    { id: "other", name: "Other", path: "/other", paths: ["/other"] },
  ];
  automations = [
    automation({
      name: "Triage",
      trigger: { kind: "status_changed", to: "Done", from: null },
      conditions: [{ kind: "project", any_of: ["existing"] }],
    }),
  ];
  const page = (version: number) => (
    <WorkspaceChangeProvider value={version}>
      <ChatClientContext value={chat}>
        <AutomationsView />
      </ChatClientContext>
    </WorkspaceChangeProvider>
  );
  const { rerender } = render(page(0));
  const rows = await screen.findByRole("list", { name: "Automations" });
  fireEvent.click((await within(rows).findAllByRole("button"))[0]!);
  const steps = await screen.findByRole("application", { name: "Steps" });
  fireEvent.click(
    within(steps).getByRole("button", {
      name: "When the status changes: To Done",
    }),
  );
  fireEvent.keyDown(
    await screen.findByRole("button", { name: "Project is: Existing" }),
    { key: "Enter" },
  );
  expect(
    await screen.findByRole("menuitemcheckbox", { name: "Other" }),
  ).toBeTruthy();

  projects = projects.map((item) => ({ ...item, archived: true }));
  rerender(page(1));
  const saved = await screen.findByRole("menuitemcheckbox", {
    name: "Existing (archived)",
  });
  expect(saved.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("menuitemcheckbox", { name: /^Other/ })).toBeNull();
  expect(automations[0]?.conditions).toEqual([
    { kind: "project", any_of: ["existing"] },
  ]);
});
