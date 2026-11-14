import { expect, test } from "vitest";
import {
  agentReach,
  textInWords,
} from "@/features/automations/automation-text";
import type { AutomationAgent } from "@/features/automations/client";

const agent = (patch: Partial<AutomationAgent>): AutomationAgent => ({
  id: "agent-1",
  name: "Triage",
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
  used_by: [],
  ...patch,
});

test("a Codex agent's reach is what its sandbox always allows, whatever switches are stored", () => {
  expect(agentReach(agent({ harness: "codex" }))).toBe(
    "Codex. Can read files, edit files, and run any command, and use the ticketd command line.",
  );
  expect(
    agentReach(
      agent({
        harness: "codex",
        tools: { ...agent({}).tools, read_files: false, use_web: true },
      }),
    ),
  ).toBe(
    "Codex. Can read files, edit files, run any command, and use the web, and use the ticketd command line.",
  );
});

test("a card's text marks each field as one, by a short name", () => {
  expect(
    textInWords("Ticket {{ticket.reference}} changed: {{ticket.title}}"),
  ).toBe("Ticket [reference] changed: [title]");
  expect(textInWords("Verified {{ticket.reference}}{{event.tag}}")).toBe(
    "Verified [reference][tag]",
  );
});

test("a Claude Code agent that may edit files may read them too", () => {
  expect(
    agentReach(
      agent({
        tools: { ...agent({}).tools, read_files: false, edit_files: true },
      }),
    ),
  ).toBe(
    "Claude Code. Can read files and edit files, and use the ticketd command line.",
  );
});

test("a Claude Code agent's reach is its own switches", () => {
  expect(agentReach(agent({}))).toBe(
    "Claude Code. Can read files, and use the ticketd command line.",
  );
});
