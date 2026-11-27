import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";
import { subAgentView } from "@/features/chats/sub-agents";

/**
 * What the Rust host sends for a nested Claude sub-agent: the view `chat_view.rs` builds
 * from the stored history of `sub_agent_nested.jsonl`. The Rust test writes the file
 * (TICKETD_UPDATE_VIEW_FIXTURES=1) and fails if it changes without it; this test reads
 * it with the schemas the interface parses real data with.
 */
const sent = JSON.parse(
  readFileSync(
    new URL("./claude-sub-agent-view.json", import.meta.url),
    "utf8",
  ),
) as unknown;

describe("the host's view of a Claude sub-agent", () => {
  const snapshot = chatSnapshotSchema.parse(sent);
  const { chat, items } = snapshot;

  it("parses with the interface's own schemas", () => {
    expect(chat.sub_agents.map((agent) => [agent.id, agent.parent ?? null])).toEqual([
      ["task_a", null],
      ["task_b", "task_a"],
    ]);
    expect(chat.sub_agents[0]).toMatchObject({
      title: "Review the limiter code",
      type: "general-purpose",
      status: "completed",
      brief: { source: "main_agent" },
      capabilities: { brief: true, resume: true, stop: false },
    });
    expect(chat.sub_agents[1]).toMatchObject({
      title: "Check the tests",
      brief: { source: "sub_agent" },
    });
  });

  it("puts one row for the direct sub-agent in the main transcript and none of its steps", () => {
    const main = items.filter((item) => !item.owner);
    expect(main.filter((item) => item.kind === "sub_agent")).toHaveLength(1);
    expect(
      main.flatMap((item) =>
        item.kind === "steps" ? item.steps.map((step) => step.kind) : [],
      ),
    ).toEqual([]);
  });

  it("owns each run's items by the sub-agent and nests the second under the first", () => {
    const rows = items.filter((item) => item.kind === "sub_agent");
    expect(rows.map((row) => [row.sub_agent, row.owner ?? null])).toEqual([
      ["task_a", null],
      ["task_b", "task_a"],
    ]);
    const nested = rows[1];
    // The row sits in the run of the parent it began in.
    expect(nested?.turn_id).toBe("task_a:run-1");
    for (const item of items.filter((one) => one.owner)) {
      expect(item.turn_id).toMatch(/^task_[ab]:run-1$/);
    }
    expect(
      items.filter((item) => item.kind === "turn" && item.owner),
    ).toHaveLength(2);
  });

  it("builds each sub-agent's view, with the path to it", () => {
    const view = subAgentView(chat, items, "task_b", Date.now());
    expect(view?.ancestors.map((agent) => agent.id)).toEqual(["task_a"]);
    expect(view?.items.map((item) => item.kind)).toEqual(["turn", "steps"]);
    expect(view?.brief.text).toBe("Read the limiter tests.");
    const outer = subAgentView(chat, items, "task_a", Date.now());
    expect(outer?.items.map((item) => item.kind)).toEqual([
      "turn",
      "steps",
      "steps",
      "sub_agent",
    ]);
  });

  it("opens in the mock client like any Chat", async () => {
    const client = createMockChatClient({
      enabled: true,
      chats: [{ chat, items }],
    });
    const opened = await client.openChat(chat.id);
    expect(opened.items).toHaveLength(items.length);
  });
});
