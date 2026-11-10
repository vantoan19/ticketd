// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentSkillsCard } from "@/features/settings/AgentSkillsCard";

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
  detected: false,
  state: "edited",
  error: null,
};
const installed = { state: "installed" };

test("Install writes the skill for that agent, shows the new state, and keeps focus on the row", async () => {
  invoke
    .mockResolvedValueOnce([claude, { ...codex, ...installed }])
    .mockResolvedValueOnce({ backup: null })
    .mockResolvedValueOnce([
      { ...claude, ...installed },
      { ...codex, ...installed },
    ]);
  render(<AgentSkillsCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Install for Claude Code" }),
  );
  await waitFor(() => expect(screen.getAllByText("Installed")).toHaveLength(2));
  expect(invoke).toHaveBeenCalledWith("install_agent_skill", {
    agent: "claude-code",
    replace: false,
  });
  expect(document.activeElement?.id).toBe("agent-skill-claude-code-state");
  expect(screen.getByText(/Codex not found on this computer/)).toBeTruthy();
});

test("an edited skill is replaced only through the review, which names the backup", async () => {
  invoke
    .mockResolvedValueOnce([{ ...claude, ...installed }, codex])
    .mockResolvedValueOnce({
      backup: "~/.agents/skills/ticketd/SKILL.md.backup-1",
    })
    .mockResolvedValueOnce([
      { ...claude, ...installed },
      { ...codex, ...installed },
    ]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText(/edited after ticketd installed it/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Replace for Codex" }));
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
  expect(
    await screen.findByText("~/.agents/skills/ticketd/SKILL.md.backup-1"),
  ).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("install_agent_skill", {
    agent: "codex",
    replace: true,
  });
});

test("an unreadable folder or a linked SKILL.md affects only its row and offers no action", async () => {
  invoke.mockResolvedValueOnce([
    { ...claude, state: null, error: "Access is denied." },
    { ...codex, state: "not_a_file" },
  ]);
  render(<AgentSkillsCard />);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Access is denied.",
  );
  expect(screen.getByText("Could not check")).toBeTruthy();
  expect(screen.getByText(/is a link or folder/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /for (Claude Code|Codex)/ }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
});
