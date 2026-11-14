// @vitest-environment jsdom
import {
  act,
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
  ListedRun,
} from "@/features/automations/client";
import { RunNavigation } from "@/features/automations/navigation";
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

const DEFAULTS = {
  name: "",
  harness: "claude-code",
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
} as const;

/** The agents the fake Workspace holds, changed by the same commands the page sends. */
let stored: AutomationAgent[] = [];
let automations: Automation[] = [];
let runs: ListedRun[] = [];
/** While set, the fake Workspace refuses to read a run with it. */
let runUnreadable: string | null = null;
/** While set, the fake Workspace refuses to save an agent with it. */
let agentUnsavable: string | null = null;
beforeEach(() => {
  stored = [];
  automations = [];
  runs = [];
  runUnreadable = null;
  agentUnsavable = null;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { id, settings, example } = (args ?? {}) as {
      id?: string;
      settings?: AutomationAgent;
      example?: string;
    };
    const add = (created: Automation) => {
      automations = [created, ...automations];
      return created;
    };
    switch (command) {
      case "automation_list":
        return automations;
      case "automation_run_list_all":
        return runs;
      case "automation_run_get":
        if (runUnreadable) throw new Error(runUnreadable);
        return {
          ...runs.find((run) => run.id === id),
          definition: { name: "", trigger: null, conditions: [], steps: [] },
          started_at: null,
          ended_at: null,
          steps: [],
        };
      case "automation_create_example":
        return add({
          ...TRIAGE,
          id: "example-1",
          name: `Example ${example}`,
          steps: [
            {
              id: "step-1",
              kind: "run_agent",
              agent_id: null,
              execution_folder: null,
            },
          ],
          problems: [
            { step_id: "step-1", message: "Needs an agent and a folder" },
          ],
        });
      case "automation_duplicate":
        return add({ ...TRIAGE, id: "copy-1", name: `${TRIAGE.name} copy` });
      case "automation_agent_list":
        return stored;
      case "automation_agent_create": {
        const agent = { id: `agent-${stored.length + 1}`, ...DEFAULTS };
        stored = [agent as unknown as AutomationAgent, ...stored];
        return agent;
      }
      case "automation_agent_update": {
        if (agentUnsavable) throw new Error(agentUnsavable);
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

const TRIAGE: Automation = {
  id: "automation-1",
  name: "Triage new tickets",
  trigger: { kind: "tag_added", tag: "ready-for-triage" },
  conditions: [],
  steps: [],
  enabled: false,
  arrived_off: false,
  problems: [],
  has_ticket: true,
};
const listed = (
  id: string,
  status: ListedRun["status"],
  title: string,
): ListedRun => ({
  id,
  automation_id: TRIAGE.id,
  automation_name: TRIAGE.name,
  status,
  reason: null,
  needs_you: status === "needs_attention",
  answer: null,
  automation_deleted: false,
  ticket: { id, reference: `T-${id}`, title },
  created_at: new Date().toISOString(),
});
const show = () =>
  render(
    <ChatClientContext value={createMockChatClient()}>
      <AutomationsView />
    </ChatClientContext>,
  );

/**
 * Shows the page under a Workspace change count and answers with what moves
 * it, as the poll does when something changed: the page then reads again.
 */
const showChanging = () => {
  const page = (version: number) => (
    <WorkspaceChangeProvider value={version}>
      <ChatClientContext value={createMockChatClient()}>
        <AutomationsView />
      </ChatClientContext>
    </WorkspaceChangeProvider>
  );
  const { rerender } = render(page(0));
  let version = 0;
  return () => act(() => rerender(page(++version)));
};

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
        any_command: false,
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

test("a limit outside its range is not saved and says why under the field, until the field is left", async () => {
  await open(undefined, [
    { id: "a1", ...DEFAULTS, name: "Triage" } as unknown as AutomationAgent,
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
  const form = await screen.findByRole("region", { name: "Triage" });
  const turns = within(form).getByRole("spinbutton", { name: "Turns" });
  const minutes = within(form).getByRole("spinbutton", { name: "Minutes" });

  for (const [field, typed, note] of [
    [
      turns,
      "99999999999",
      "A whole number from 1 to 500. Until then, 40 is kept.",
    ],
    [turns, "0", "A whole number from 1 to 500. Until then, 40 is kept."],
    [turns, "1.5", "A whole number from 1 to 500. Until then, 40 is kept."],
    [minutes, "241", "A whole number from 1 to 240. Until then, 20 is kept."],
  ] as const) {
    fireEvent.change(field, { target: { value: typed } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByRole("alert").textContent).toBe(note);
    fireEvent.blur(field);
    expect(within(form).queryByRole("alert")).toBeNull();
  }
  expect(invoke).not.toHaveBeenCalledWith(
    "automation_agent_update",
    expect.anything(),
  );

  fireEvent.change(turns, { target: { value: "500" } });
  await waitFor(() => expect(stored[0]).toMatchObject({ turn_limit: 500 }));
});

test("switching the harness clears a model typed for the other one", async () => {
  await open(undefined, [
    {
      id: "a1",
      ...DEFAULTS,
      name: "Triage",
      model: "claude-sonnet-4-5",
    } as unknown as AutomationAgent,
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
  const form = await screen.findByRole("region", { name: "Triage" });
  const model = within(form).getByRole("textbox", {
    name: /Model/,
  }) as HTMLInputElement;
  expect(model.value).toBe("claude-sonnet-4-5");

  fireEvent.click(within(form).getByRole("radio", { name: /Codex/ }));

  expect(model.value).toBe("");
  await waitFor(() =>
    expect(stored[0]).toMatchObject({ harness: "codex", model: null }),
  );
});

test("deleting an agent asks first, then removes it from the list", async () => {
  await open(undefined, [
    { id: "a1", ...DEFAULTS, name: "Triage" } as unknown as AutomationAgent,
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
  await screen.findByRole("region", { name: "Triage" });

  fireEvent.keyDown(screen.getByRole("button", { name: "Agent actions" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
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

test("with Codex chosen, the switches it cannot enforce are fixed on and the turn limit is not applied; Claude Code brings the agent's own choices back", async () => {
  await open(undefined, [
    {
      id: "a1",
      ...DEFAULTS,
      name: "Triage",
      harness: "codex",
      tools: { ...DEFAULTS.tools, read_files: false },
    } as unknown as AutomationAgent,
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
  const form = await screen.findByRole("region", { name: "Triage" });
  const control = (role: "switch" | "spinbutton", name: string) =>
    within(form).getByRole(role, { name }) as HTMLButtonElement;

  for (const name of ["Read files", "Edit files", "Run commands"]) {
    expect(control("switch", name).getAttribute("aria-checked")).toBe("true");
    expect(control("switch", name).disabled).toBe(true);
  }
  // Codex has no list of commands to allow.
  expect(
    within(form).queryByRole("textbox", { name: "Allowed commands" }),
  ).toBeNull();
  // The web is the one switch Codex's sandbox follows.
  expect(control("switch", "Use the web").disabled).toBe(false);
  expect(control("switch", "Use the web").getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(within(form).getByText(/Codex applies its own sandbox/)).toBeTruthy();
  expect(control("spinbutton", "Turns").disabled).toBe(true);
  expect(within(form).getByText("Not applied with Codex")).toBeTruthy();
  expect(control("spinbutton", "Minutes").disabled).toBe(false);

  fireEvent.click(within(form).getByRole("radio", { name: /Claude Code/ }));

  for (const name of ["Read files", "Edit files", "Run commands"]) {
    expect(control("switch", name).getAttribute("aria-checked")).toBe("false");
    expect(control("switch", name).disabled).toBe(false);
  }
  expect(within(form).queryByText(/Codex applies its own sandbox/)).toBeNull();
  expect(control("spinbutton", "Turns").disabled).toBe(false);
  // What Codex showed as fixed was never saved over the agent's own choices.
  await waitFor(() => expect(stored[0]?.harness).toBe("claude-code"));
  expect(stored[0]?.tools).toEqual({ ...DEFAULTS.tools, read_files: false });
});

test("the Runs view lists every run under Now, Needs you and Earlier, naming its Automation, and opens the one chosen", async () => {
  automations = [TRIAGE];
  runs = [
    listed("3", "running", "Show the wait time"),
    listed("2", "needs_attention", "Login flickers"),
    listed("1", "completed", "Rate-limit logins"),
  ];
  show();

  // The tab says a run needs the person before it is opened.
  const tab = await screen.findByRole("radio", { name: /^Runs/ });
  await waitFor(() => expect(tab.textContent).toContain("needs you"));
  fireEvent.click(tab);

  const group = (name: string) =>
    screen.getByRole("list", { name: `Runs, ${name}` }).textContent;
  expect(group("Now")).toContain("Show the wait time");
  expect(group("Needs you")).toContain("Login flickers");
  expect(group("Needs you")).toContain("Triage new tickets");
  expect(group("Earlier")).toContain("Rate-limit logins");

  fireEvent.click(screen.getByRole("button", { name: /Login flickers/ }));

  const heading = await screen.findByRole("heading", { name: /Run on T-2/ });
  expect(heading.textContent).toContain("Triage new tickets");
});

test("a run the person dismissed is listed under Earlier and leaves the Runs tab unmarked", async () => {
  runs = [
    {
      ...listed("1", "needs_attention", "Rate-limit logins"),
      needs_you: false,
    },
  ];
  show();
  fireEvent.click(await screen.findByRole("radio", { name: /^Runs/ }));

  await screen.findByRole("list", { name: "Runs, Earlier" });
  expect(
    screen.getByRole("radio", { name: /^Runs/ }).textContent,
  ).not.toContain("needs you");
});

test("the empty page offers New Automation and three examples, and choosing one opens it with what it still needs", async () => {
  show();

  const examples = await screen.findByRole("group", {
    name: "Start from an example",
  });
  expect(
    within(examples)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual([
    expect.stringContaining("Triage tagged tickets"),
    expect.stringContaining("Verify what is ready for testing"),
    expect.stringContaining("Weekly summary"),
  ]);
  expect(
    screen.getAllByRole("button", { name: "New Automation" }).length,
  ).toBeGreaterThan(1);

  fireEvent.click(
    within(examples).getByRole("button", { name: /Weekly summary/ }),
  );

  await screen.findByRole("heading", { name: "Example weekly_summary" });
  expect(await screen.findByText("Needs an agent and a folder")).toBeTruthy();
  expect(
    (
      screen.getByRole("switch", {
        name: "On for this desktop",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("Duplicate in an Automation’s menu makes a copy and opens it", async () => {
  automations = [TRIAGE];
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /Triage new tickets/ }),
  );
  fireEvent.keyDown(
    await screen.findByRole("button", { name: "Automation actions" }),
    { key: "Enter" },
  );

  fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

  await screen.findByRole("heading", { name: "Triage new tickets copy" });
  expect(
    within(screen.getByRole("list", { name: "Automations" })).getAllByRole(
      "button",
    ),
  ).toHaveLength(2);
});

test("a run chosen in the Runs view goes through the page's run navigation and opens beside the list", async () => {
  runs = [listed("2", "needs_attention", "Login flickers")];
  const navigate = vi.fn();
  const page = (openRun: { id: string; key: number } | null) => (
    <RunNavigation value={navigate}>
      <ChatClientContext value={createMockChatClient()}>
        <AutomationsView openRun={openRun} />
      </ChatClientContext>
    </RunNavigation>
  );
  const { rerender } = render(page(null));
  fireEvent.click(await screen.findByRole("radio", { name: /^Runs/ }));

  fireEvent.click(
    await screen.findByRole("button", { name: /Login flickers/ }),
  );
  expect(navigate).toHaveBeenCalledWith("2");
  rerender(page({ id: "2", key: 1 }));

  await screen.findByRole("heading", { name: /Run on T-2/ });
  expect(
    screen.getByRole("radio", { name: /^Runs/ }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("a list row says how the Automation's latest run stands, and Off for one that is off", async () => {
  automations = [
    { ...TRIAGE, enabled: true },
    { ...TRIAGE, id: "automation-2", name: "Weekly summary" },
  ];
  // Newest first, both of the first Automation.
  runs = [
    listed("2", "needs_attention", "Login flickers"),
    listed("1", "completed", "Fix the footer"),
  ];
  show();

  const rows = await screen.findByRole("list", { name: "Automations" });
  await waitFor(() =>
    expect(within(rows).getAllByRole("button")[0]?.textContent).toContain(
      "Needs attention",
    ),
  );
  const [on, off] = within(rows).getAllByRole("button");
  expect(on?.querySelector(".chat-row-time")?.textContent).not.toBe("");
  expect(off?.querySelector(".chat-row-sub")?.textContent).toMatch(/^Off/);
});

test("a run asked for from elsewhere is opened once, and one whose Automation was deleted opens among all runs", async () => {
  // The run's Automation is not in the list: it was deleted.
  runs = [listed("2", "needs_attention", "Login flickers")];
  const opened = vi.fn();
  render(
    <ChatClientContext value={createMockChatClient()}>
      <AutomationsView openRun={{ id: "2", key: 1 }} onRunOpened={opened} />
    </ChatClientContext>,
  );

  await screen.findByRole("heading", { name: /Run on T-2/ });
  expect(
    screen.getByRole("radio", { name: /^Runs/ }).getAttribute("aria-checked"),
  ).toBe("true");
  // The asker is told, so it forgets the run and a later visit shows the list.
  await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
});

test("a switch that fails says so on the page until it is dismissed, not in the list alone", async () => {
  automations = [TRIAGE];
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /Triage new tickets/ }),
  );

  // The fake Workspace refuses to switch anything on.
  fireEvent.click(
    await screen.findByRole("switch", { name: "On for this desktop" }),
  );

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("It could not be switched on.");
  // Above both panes, so it shows whichever one is on screen.
  expect(alert.closest(".ticket-list")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a read of the open run that fails says so only until that read works again", async () => {
  automations = [TRIAGE];
  runs = [listed("2", "needs_attention", "Login flickers")];
  const workspaceChanged = showChanging();
  fireEvent.click(await screen.findByRole("radio", { name: /^Runs/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Login flickers/ }),
  );
  await screen.findByRole("heading", { name: /Run on T-2/ });

  // The Workspace changes while it is busy: the run cannot be read this once.
  runUnreadable = "the workspace is busy";
  workspaceChanged();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("the workspace is busy");

  // The next change reads it: nothing is wrong any more, so nothing says so.
  runUnreadable = null;
  workspaceChanged();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("heading", { name: /Run on T-2/ })).toBeTruthy();
});

test("Run commands allows only the commands listed unless Any command is chosen", async () => {
  await open(createMockChatClient(), [
    {
      ...DEFAULTS,
      id: "agent-1",
      name: "Triage",
      tools: { ...DEFAULTS.tools, run_commands: true },
      used_by: [],
    } as unknown as AutomationAgent,
  ]);
  fireEvent.click(await screen.findByRole("button", { name: /Triage/ }));
  const form = await screen.findByRole("region", { name: "Triage" });
  // An empty list is not "any command": the list is there to fill in.
  expect(
    within(form).getByRole("textbox", { name: "Allowed commands" }),
  ).toBeTruthy();
  expect(form.textContent).toContain(
    "Claude Code may still run shell commands that only read",
  );

  fireEvent.click(within(form).getByRole("radio", { name: "Any command" }));

  await waitFor(() =>
    expect(stored[0]?.tools).toMatchObject({
      run_commands: true,
      any_command: true,
    }),
  );
  expect(
    within(form).queryByRole("textbox", { name: "Allowed commands" }),
  ).toBeNull();
});

const ANY_COMMAND = {
  ...DEFAULTS,
  id: "a1",
  name: "Triage",
  tools: { ...DEFAULTS.tools, run_commands: true, any_command: true },
  used_by: [],
} as unknown as AutomationAgent;

/** Opens the one agent the fake Workspace holds; answers with its form. */
const openAgent = async () => {
  fireEvent.click(await screen.findByRole("radio", { name: /^Agents/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Triage/ }));
  return screen.findByRole("region", { name: "Triage" });
};

test("an agent changed elsewhere is taken by the open form, so the next edit does not put the old one back", async () => {
  stored = [ANY_COMMAND];
  const workspaceChanged = showChanging();
  const form = await openAgent();

  // Another desktop narrows it to one command and lowers a limit; sync brings that here.
  stored = [
    {
      ...ANY_COMMAND,
      turn_limit: 7,
      tools: {
        ...ANY_COMMAND.tools,
        any_command: false,
        allowed_commands: ["npm test"],
      },
    },
  ];
  workspaceChanged();

  const commands = await within(form).findByRole("textbox", {
    name: "Allowed commands",
  });
  expect((commands as HTMLTextAreaElement).value).toBe("npm test");
  expect(
    (
      within(form).getByRole("spinbutton", {
        name: "Turns",
      }) as HTMLInputElement
    ).value,
  ).toBe("7");
  expect(screen.queryByText("Changed somewhere else")).toBeNull();

  fireEvent.change(within(form).getByRole("textbox", { name: "Name" }), {
    target: { value: "Verifier" },
  });

  await waitFor(() => expect(stored[0]?.name).toBe("Verifier"));
  expect(stored[0]).toMatchObject({
    turn_limit: 7,
    tools: { any_command: false, allowed_commands: ["npm test"] },
  });
});

test("an agent changed elsewhere under a change that was not saved asks which to keep", async () => {
  stored = [ANY_COMMAND];
  const workspaceChanged = showChanging();
  const form = await openAgent();
  const name = within(form).getByRole("textbox", {
    name: "Name",
  }) as HTMLInputElement;
  agentUnsavable = "the workspace is busy";
  fireEvent.change(name, { target: { value: "Verifier" } });
  await screen.findByRole("alert");

  agentUnsavable = null;
  stored = [{ ...ANY_COMMAND, name: "Triage bugs" }];
  workspaceChanged();

  const notice = (await screen.findByText("Changed somewhere else")).closest(
    "[data-slot=alert]",
  ) as HTMLElement;
  // Nothing is overwritten, here or there, until the person says.
  expect(name.value).toBe("Verifier");
  expect(stored[0]?.name).toBe("Triage bugs");

  fireEvent.click(
    within(notice).getByRole("button", { name: "Use that version" }),
  );

  await waitFor(() => expect(name.value).toBe("Triage bugs"));
  expect(screen.queryByText("Changed somewhere else")).toBeNull();
  expect(stored[0]?.name).toBe("Triage bugs");
});
