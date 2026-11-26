import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentSkillsCard } from "@/features/settings/AgentSkillsCard";
import {
  SettingsStateContext,
  type SettingsState,
} from "@/features/settings/use-settings-state";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const claude = {
  id: "claude-code",
  name: "Claude Code",
  path: "~/.claude/skills/ticketd",
  detected: true,
  state: "not_installed",
  error: null,
};
const codex = {
  id: "codex",
  name: "Codex",
  path: "~/.agents/skills/ticketd",
  detected: true,
  state: "update_available",
  error: null,
};
const antigravity = {
  id: "antigravity",
  name: "Antigravity",
  path: "~/.gemini/config/skills/ticketd",
  detected: true,
  state: "installed",
  error: null,
};
const settingsState: SettingsState = {
  query: "",
  setQuery: () => {},
  openPage: () => {},
  needsSetup: {},
  refreshIndicators: () => {},
};
const installed = { state: "installed" };
const cliFound = {
  found: true,
  on_path: true,
  path: "/usr/local/bin/ticketd",
  version: "0.2.0",
  version_matches: true,
  workspace_path: null,
  workspace_matches: true,
  app_version: "0.2.0",
  app_workspace_path: null,
  suggested_directory: "/usr/local/bin",
};

/**
 * Answers each bridge command by name: `lists` is what each read of the skill
 * folders returns in turn (the last one repeats), `cli` the command's state.
 */
function bridge(
  lists: unknown[][],
  options: { cli?: object | Error; installs?: unknown[] } = {},
) {
  let reads = 0;
  const installs = [...(options.installs ?? [])];
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "agent_skills": {
        const next = lists[Math.min(reads, lists.length - 1)];
        reads += 1;
        if (next instanceof Error) throw next;
        return next;
      }
      case "install_agent_skill":
        return installs.shift() ?? { backup: null };
      case "check_cli":
        if (options.cli instanceof Error) throw options.cli;
        return options.cli ?? cliFound;
    }
    throw new Error(`unexpected command ${command}`);
  });
}

function skillStatus() {
  return document.getElementById("agent-skill-status")?.textContent ?? "";
}

test("one action installs or updates every agent that needs it, then focuses the status", async () => {
  bridge([
    [claude, codex],
    [
      { ...claude, ...installed },
      { ...codex, ...installed },
    ],
  ]);
  render(<AgentSkillsCard />);
  await waitFor(() => expect(skillStatus()).toContain("Update available"));
  fireEvent.click(
    screen.getByRole("button", { name: "Update for Claude Code and Codex" }),
  );
  await waitFor(() =>
    expect(document.activeElement?.id).toBe("agent-skill-status"),
  );
  expect(document.activeElement?.textContent).toContain("Installed");
  expect(invoke).toHaveBeenCalledWith("install_agent_skill", {
    agent: "claude-code",
    replace: false,
  });
  expect(invoke).toHaveBeenCalledWith("install_agent_skill", {
    agent: "codex",
    replace: false,
  });
  expect(screen.getByRole("status").textContent).toBe(
    "Done for Claude Code and Codex.",
  );
  expect(screen.queryByRole("button", { name: /for Claude Code/ })).toBeNull();
});

test("a newly found agent waits for the person, named on the one action", async () => {
  bridge([
    [
      { ...claude, ...installed },
      { ...codex, ...installed },
      { ...antigravity, state: "not_installed" },
    ],
  ]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText(
      "Antigravity is new on this computer and doesn’t have the skill yet.",
    ),
  ).toBeTruthy();
  expect(skillStatus()).toBe("Not installed");
  expect(
    screen.getByRole("button", { name: "Install for Antigravity" }),
  ).toBeTruthy();
  // Nothing was written without a click.
  expect(invoke).not.toHaveBeenCalledWith(
    "install_agent_skill",
    expect.anything(),
  );
  const row = screen.getByText("Antigravity", { selector: "div" });
  expect(row.closest('[role="listitem"]')?.textContent).toContain(
    ".gemini/config/skills",
  );
});

test("with every copy current the page says so quietly and offers Check again", async () => {
  bridge([
    [
      { ...claude, ...installed },
      { ...codex, ...installed },
      { ...antigravity, ...installed },
    ],
  ]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText(
      "Up to date for every agent below. It updates when ticketd does.",
    ),
  ).toBeTruthy();
  expect(skillStatus()).toBe("Installed");
  expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(
    1,
  );
  expect(screen.queryByRole("heading", { name: "ticketd skill" })).toBeNull();
  expect(screen.queryByText("SKILL.md")).toBeNull();
});

test("an agent missing from this computer is left out of the action", async () => {
  bridge([[claude, { ...codex, state: "not_installed", detected: false }]]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByRole("button", { name: "Install for Claude Code" }),
  ).toBeTruthy();
  const codexRow = screen.getByText("Codex").closest('[role="listitem"]');
  expect(
    within(codexRow as HTMLElement).getByText("Not found on this computer"),
  ).toBeTruthy();
});

test("a copy a newer ticketd wrote counts as installed, with nothing to update", async () => {
  bridge([
    [
      { ...claude, state: "newer" },
      { ...codex, state: "not_installed", detected: false },
    ],
  ]);
  render(<AgentSkillsCard />);
  await waitFor(() => expect(skillStatus()).toContain("Installed"));
  expect(
    screen.getByText(
      "Up to date for Claude Code. It updates when ticketd does.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /for Claude Code/ })).toBeNull();
});

test("a copy installed before its agent was found still names that agent", async () => {
  bridge([
    [
      { ...claude, ...installed, detected: false },
      { ...codex, state: "not_installed", detected: false },
    ],
  ]);
  render(<AgentSkillsCard />);
  await waitFor(() => expect(skillStatus()).toContain("Installed"));
  expect(
    screen.getByText(
      "Up to date for Claude Code. It updates when ticketd does.",
    ),
  ).toBeTruthy();
});

test("an edited copy is left alone and is replaced only through the review, which names the backup", async () => {
  bridge(
    [
      [
        { ...claude, ...installed },
        { ...codex, state: "edited" },
      ],
      [
        { ...claude, ...installed },
        { ...codex, ...installed },
      ],
    ],
    { installs: [{ backup: "~/.agents/skills/ticketd/SKILL.md.backup-1" }] },
  );
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText(
      "Your Codex copy was edited, so ticketd left it alone.",
    ),
  ).toBeTruthy();
  expect(skillStatus()).toBe("Needs a look");
  expect(
    screen.getByText("Edited after ticketd installed it.", { exact: false }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /^(Install|Update) for/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Replace for Codex" }));
  expect(invoke).not.toHaveBeenCalledWith(
    "install_agent_skill",
    expect.anything(),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
  expect((await screen.findByRole("status")).textContent).toContain(
    "~/.agents/skills/ticketd/SKILL.md.backup-1",
  );
  expect(invoke).toHaveBeenCalledWith("install_agent_skill", {
    agent: "codex",
    replace: true,
  });
});

test("a copy ticketd could not update on its own offers Update", async () => {
  bridge([[{ ...claude, state: "update_available" }]]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText(
      "The ticketd skill for Claude Code is out of date.",
    ),
  ).toBeTruthy();
  expect(skillStatus()).toBe("Update available");
  expect(
    screen.getByRole("button", { name: "Update for Claude Code" }),
  ).toBeTruthy();
});

test("without the command the status says agents cannot run ticketd and links to Command line", async () => {
  bridge([[{ ...claude, ...installed }]], {
    cli: { ...cliFound, found: false, on_path: false, version: null },
  });
  const openPage = vi.fn();
  render(
    <SettingsStateContext.Provider value={{ ...settingsState, openPage }}>
      <AgentSkillsCard />
    </SettingsStateContext.Provider>,
  );
  expect(
    await screen.findByText(
      "Agents can’t run ticketd until the command line is installed.",
    ),
  ).toBeTruthy();
  expect(skillStatus()).toBe("No command");
  const status = screen.getByRole("region", { name: "Skill status" });
  fireEvent.click(within(status).getByRole("button", { name: "Command line" }));
  expect(openPage).toHaveBeenCalledWith("command-line");
});

test("a command that cannot be read does not change the skill status", async () => {
  bridge([[{ ...claude, ...installed }]], { cli: new Error("no probe") });
  render(<AgentSkillsCard />);
  await waitFor(() => expect(skillStatus()).toBe("Installed"));
});

test("an unreadable folder or a linked SKILL.md stays in its row with no Replace", async () => {
  bridge([
    [
      { ...claude, state: null, error: "Access is denied." },
      { ...codex, state: "not_a_file" },
    ],
  ]);
  render(<AgentSkillsCard />);
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("Access is denied.");
  expect(screen.getByText("Couldn't check")).toBeTruthy();
  expect(screen.getByText(/is a link or folder/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Replace/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
});

test("Check again reads the folders again", async () => {
  bridge([
    [
      { ...claude, ...installed },
      { ...codex, ...installed },
    ],
    [
      { ...claude, ...installed },
      { ...codex, ...installed },
      { ...antigravity, state: "not_installed" },
    ],
  ]);
  render(<AgentSkillsCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  await waitFor(() => expect(skillStatus()).toContain("Not installed"));
  expect(
    invoke.mock.calls.filter(([command]) => command === "agent_skills"),
  ).toHaveLength(2);
});

test("a failed read says so and offers Retry", async () => {
  bridge([
    new Error("Disk unavailable") as unknown as unknown[],
    [
      { ...claude, ...installed },
      { ...codex, ...installed },
    ],
  ]);
  render(<AgentSkillsCard />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't check agent skills",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(skillStatus()).toContain("Installed"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("with no supported agent on this computer the status says what to do and every row says not found", async () => {
  bridge([
    [
      { ...claude, detected: false, state: "not_installed" },
      { ...codex, detected: false, state: "not_installed" },
      { ...antigravity, detected: false, state: "not_installed" },
    ],
  ]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText(
      "No agent found. Install Claude Code, Codex or Antigravity, then choose Check again.",
    ),
  ).toBeTruthy();
  expect(skillStatus()).toBe("No agent found");
  expect(screen.getAllByText("Not found on this computer")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /^Install for/ })).toBeNull();
});

test("the Replace review shows the folder, and the footer links open Command line and Agents", async () => {
  bridge([
    [
      { ...claude, state: "edited" },
      { ...codex, ...installed },
    ],
  ]);
  const openPage = vi.fn();
  render(
    <SettingsStateContext.Provider value={{ ...settingsState, openPage }}>
      <AgentSkillsCard />
    </SettingsStateContext.Provider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace for Claude Code" }),
  );
  const dialog = await screen.findByRole("dialog");
  // The folder as PathText: its last folder on line one, the rest under it.
  expect(within(dialog).getByText("ticketd")).toBeTruthy();
  expect(dialog.textContent).toContain(".claude/skills");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const agents = screen.getByRole("region", {
    name: "Agents on this computer",
  });
  fireEvent.click(within(agents).getByRole("button", { name: "Command line" }));
  expect(openPage).toHaveBeenLastCalledWith("command-line");
  fireEvent.click(within(agents).getByRole("button", { name: "Agents" }));
  expect(openPage).toHaveBeenLastCalledWith("agents");
});
