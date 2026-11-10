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
  expect(
    await screen.findByText("Update available", {
      selector: "#agent-skill-status",
    }),
  ).toBeTruthy();
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
  const codexRow = screen.getByText("Codex").closest("li");
  expect(
    within(codexRow as HTMLElement).getByText("Not found on this computer"),
  ).toBeTruthy();
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
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Access is denied.",
  );
  expect(screen.getByText("Could not check")).toBeTruthy();
  expect(screen.getByText(/is a link or folder/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Replace/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
});
