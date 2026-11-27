// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  mainItems,
  subAgentLabel,
  subAgentSuffix,
} from "@/features/chats/model";
import { subAgentView } from "@/features/chats/sub-agents";
import { SubAgentControl } from "@/features/chats/SubAgentView";
import {
  antigravityChat,
  codexChat,
  subAgentFixtures,
} from "@/features/chats/sub-agent-fixtures";

afterEach(cleanup);

const NOW = Date.parse("2026-11-27T12:00:00Z");
const run = (over: Record<string, unknown>) => ({
  status: "completed" as const,
  run: 1,
  started_at: "2026-11-27T11:57:00Z",
  ended_at: "2026-11-27T11:58:04Z",
  ...over,
});
const full = {
  capabilities: {
    brief: true,
    text: true,
    end: true,
    stop: true,
    resume: true,
  },
};

test("a row's suffix: a clock while it runs, a duration when it finished, a word for any other end", () => {
  expect(
    subAgentSuffix(run({ status: "running", ended_at: null }), full, NOW),
  ).toEqual([{ text: "3m" }]);
  expect(subAgentSuffix(run({}), full, NOW)).toEqual([{ text: "1m 4s" }]);
  expect(subAgentSuffix(run({ status: "failed" }), full, NOW)).toEqual([
    { text: "Failed", outcome: true },
  ]);
  expect(subAgentSuffix(run({ status: "lost" }), full, NOW)).toEqual([
    { text: "Contact lost", outcome: true },
  ]);
  expect(
    subAgentSuffix(
      run({
        run: 2,
        status: "running",
        ended_at: null,
        started_at: "2026-11-27T11:59:25Z",
      }),
      full,
      NOW,
    ),
  ).toEqual([{ text: "Resumed" }, { text: "35s" }]);
  // A harness that never says when it finished: the row says it ended with the turn.
  expect(
    subAgentSuffix(
      run({}),
      { capabilities: { ...full.capabilities, end: false } },
      NOW,
    ),
  ).toEqual([{ text: "Ended with the turn" }]);
});

test("a row is named for what it is and how it stands, with the clock only while it means something", () => {
  expect(
    subAgentLabel(
      "Find bypasses",
      run({ status: "running", ended_at: null }),
      full,
      NOW,
    ),
  ).toBe("Sub-agent Find bypasses, working, 3m");
  expect(
    subAgentLabel("Find bypasses", run({ status: "stopped" }), full, NOW),
  ).toBe("Sub-agent Find bypasses, stopped");
});

test("the main transcript keeps only the main agent's items, and a Chat without sub-agents keeps its own array", () => {
  const { chat, items } = subAgentFixtures().finished;
  const all = items ?? [];
  const main = mainItems(all);
  expect(main.length).toBeLessThan(all.length);
  expect(main.every((item) => !item.owner)).toBe(true);
  expect(main.filter((item) => item.kind === "sub_agent")).toHaveLength(3);
  const plain = (items ?? []).filter(
    (item) => !item.owner && item.kind !== "sub_agent",
  );
  expect(mainItems(plain)).toBe(plain);
  expect(chat.sub_agents).toHaveLength(3);
});

test("a sub-agent view carries its brief, its path and what the harness does not report", () => {
  const codex = codexChat();
  const nested = subAgentView(codex.chat, codex.items ?? [], "sa-pay-tests");
  expect(nested?.ancestors.map((one) => one.title)).toEqual([
    "Update the refund calls",
  ]);
  expect(nested?.brief).toEqual({
    source: "Asked by the sub-agent Update the refund calls · GPT-6.2",
    text: "Codex doesn't report what a sub-agent was asked.",
    reported: false,
  });
  const agy = antigravityChat();
  const ended = subAgentView(agy.chat, agy.items ?? [], "sa-routes");
  expect(ended?.limits).toBe(true);
  expect(ended?.ending).toBeNull();
  expect(subAgentView(agy.chat, agy.items ?? [], "nobody")).toBeUndefined();
});

test("a resumed sub-agent's runs are split by a quiet line", () => {
  const { chat, items } = subAgentFixtures().resumed;
  const view = subAgentView(chat, items ?? [], "sa-tests");
  expect(view?.parts.map((part) => part.kind)).toEqual([
    "turn",
    "divider",
    "turn",
  ]);
});

test("the control row says what the sub-agent is doing, and Stop asks to stop it by name", () => {
  const { chat, items } = subAgentFixtures().running;
  const view = subAgentView(chat, items ?? [], "sa-bypass")!;
  const stop = vi.fn();
  render(<SubAgentControl view={view} onStop={stop} />);
  expect(screen.getByRole("status").textContent).toMatch(/^Working · 2m/);
  fireEvent.click(
    screen.getByRole("button", { name: "Stop Find limiter bypasses" }),
  );
  expect(stop).toHaveBeenCalledTimes(1);
});
