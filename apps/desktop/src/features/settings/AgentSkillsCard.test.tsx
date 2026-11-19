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
const installed = { state: "installed" };

function skillStatus() {
  return document.getElementById("agent-skill-status")?.textContent ?? "";
}

test("one action installs or updates every agent that needs it, then focuses the status", async () => {
  invoke
    .mockResolvedValueOnce([claude, codex])
    .mockResolvedValueOnce({ backup: null })
    .mockResolvedValueOnce({ backup: null })
    .mockResolvedValueOnce([
      { ...claude, ...installed },
      { ...codex, ...installed },
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

test("an agent missing from this computer is left out of the action", async () => {
  invoke.mockResolvedValueOnce([
    claude,
    { ...codex, state: "not_installed", detected: false },
  ]);
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
  invoke.mockResolvedValueOnce([
    { ...claude, state: "newer" },
    { ...codex, state: "not_installed", detected: false },
  ]);
  render(<AgentSkillsCard />);
  await waitFor(() => expect(skillStatus()).toContain("Installed"));
  expect(screen.getByText("Up to date for Claude Code.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /for Claude Code/ })).toBeNull();
});

test("a copy installed before its agent was found still names that agent", async () => {
  invoke.mockResolvedValueOnce([
    { ...claude, ...installed, detected: false },
    { ...codex, state: "not_installed", detected: false },
  ]);
  render(<AgentSkillsCard />);
  await waitFor(() => expect(skillStatus()).toContain("Installed"));
  expect(screen.getByText("Up to date for Claude Code.")).toBeTruthy();
});

test("an edited copy is replaced only through the review, which names the backup", async () => {
  invoke
    .mockResolvedValueOnce([
      { ...claude, ...installed },
      { ...codex, state: "edited" },
    ])
    .mockResolvedValueOnce({
      backup: "~/.agents/skills/ticketd/SKILL.md.backup-1",
    })
    .mockResolvedValueOnce([
      { ...claude, ...installed },
      { ...codex, ...installed },
    ]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText("Edited after ticketd installed it.", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /^(Install|Update) for/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Replace for Codex" }));
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
  expect((await screen.findByRole("status")).textContent).toContain(
    "~/.agents/skills/ticketd/SKILL.md.backup-1",
  );
  expect(invoke).toHaveBeenCalledWith("install_agent_skill", {
    agent: "codex",
    replace: true,
  });
});

test("an unreadable folder or a linked SKILL.md stays in its row with no Replace", async () => {
  invoke.mockResolvedValueOnce([
    { ...claude, state: null, error: "Access is denied." },
    { ...codex, state: "not_a_file" },
  ]);
  render(<AgentSkillsCard />);
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("Access is denied.");
  expect(screen.getByText("Couldn't check")).toBeTruthy();
  expect(screen.getByText(/is a link or folder/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Replace/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
});

test("Check again belongs to the Agents section and reads the folders again", async () => {
  invoke.mockResolvedValueOnce([claude, codex]).mockResolvedValueOnce([
    { ...claude, ...installed },
    { ...codex, ...installed },
  ]);
  render(<AgentSkillsCard />);
  const agents = await screen.findByRole("region", {
    name: "Agents on this computer",
  });
  fireEvent.click(within(agents).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(skillStatus()).toContain("Installed"));
  expect(invoke).toHaveBeenCalledTimes(2);
});

test("a failed read says so and offers Retry", async () => {
  invoke
    .mockRejectedValueOnce(new Error("Disk unavailable"))
    .mockResolvedValueOnce([
      { ...claude, ...installed },
      { ...codex, ...installed },
    ]);
  render(<AgentSkillsCard />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't check agent skills",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(skillStatus()).toContain("Installed"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("with no supported agent on this computer the empty state explains what to do", async () => {
  invoke.mockResolvedValueOnce([
    { ...claude, detected: false },
    { ...codex, detected: false, state: "not_installed" },
  ]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText("No supported agent was found on this computer"),
  ).toBeTruthy();
  expect(
    screen.getByText("Install Claude Code or Codex, then choose Check again."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Install for/ })).toBeNull();
});

test("the Replace review shows the folder, and the footnote opens Command line", async () => {
  invoke.mockResolvedValueOnce([
    { ...claude, state: "edited" },
    { ...codex, ...installed },
  ]);
  const openPage = vi.fn();
  const state: SettingsState = {
    query: "",
    setQuery: () => {},
    openPage,
    needsSetup: {},
    refreshIndicators: () => {},
  };
  render(
    <SettingsStateContext.Provider value={state}>
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
  expect(
    screen.getByRole("button", { name: "Check the command line" }).dataset.slot,
  ).toBe("settings-link");
  fireEvent.click(
    screen.getByRole("button", { name: "Check the command line" }),
  );
  expect(openPage).toHaveBeenCalledWith("command-line");
});
