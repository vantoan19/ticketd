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
};
const codex = {
  id: "codex",
  name: "Codex",
  path: "~/.agents/skills/ticketd",
  detected: false,
  state: "edited",
};

test("Install writes the skill for that agent and shows the new state", async () => {
  invoke
    .mockResolvedValueOnce([claude, { ...codex, state: "installed" }])
    .mockResolvedValueOnce({ backup: null })
    .mockResolvedValueOnce([
      { ...claude, state: "installed" },
      { ...codex, state: "installed" },
    ]);
  render(<AgentSkillsCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Install" }));
  await waitFor(() => expect(screen.getAllByText("Installed")).toHaveLength(2));
  expect(invoke).toHaveBeenCalledWith("install_agent_skill", {
    agent: "claude-code",
    replace: false,
  });
  expect(screen.getByText(/Codex not found on this computer/)).toBeTruthy();
});

test("an edited skill is replaced only through the review, which names the backup", async () => {
  invoke
    .mockResolvedValueOnce([{ ...claude, state: "installed" }, codex])
    .mockResolvedValueOnce({
      backup: "~/.agents/skills/ticketd/SKILL.md.backup-1",
    })
    .mockResolvedValueOnce([
      { ...claude, state: "installed" },
      { ...codex, state: "installed" },
    ]);
  render(<AgentSkillsCard />);
  expect(
    await screen.findByText(/edited after ticketd installed it/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
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
