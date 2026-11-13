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
  ListedRun,
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
let automations: Automation[] = [];
let runs: ListedRun[] = [];
beforeEach(() => {
  stored = [];
  automations = [];
  runs = [];
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
  ticket: { id, reference: `T-${id}`, title },
  created_at: new Date().toISOString(),
});
const show = () =>
  render(
    <ChatClientContext value={createMockChatClient()}>
      <AutomationsView />
    </ChatClientContext>,
  );

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

test("the Runs tab has no mark while no run needs the person", async () => {
  runs = [listed("1", "completed", "Rate-limit logins")];
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
