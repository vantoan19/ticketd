import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "@/features/chats/client";
import { subAgentView } from "@/features/chats/sub-agents";

/**
 * What the Rust host sends for nested Codex sub-agents: the view `chat_view.rs` builds from
 * the stored history of `sub_agent_nested.jsonl` (hand-built from the shapes of live codex-cli
 * 0.172.0 captures) while both sub-agents run. The Rust test writes the file
 * (TICKETD_UPDATE_VIEW_FIXTURES=1) and fails if it changes without it; this test reads it
 * with the schemas the interface parses real data with.
 */
const sent = JSON.parse(
  readFileSync(new URL("./codex-sub-agent-view.json", import.meta.url), "utf8"),
) as unknown;

describe("the host's view of Codex sub-agents", () => {
  const { chat, items } = chatSnapshotSchema.parse(sent);

  it("parses with the interface's own schemas, and Codex reports no brief", () => {
    expect(
      chat.sub_agents.map((agent) => [agent.id, agent.parent ?? null]),
    ).toEqual([
      ["thr_a", null],
      ["thr_b", "thr_a"],
    ]);
    expect(chat.sub_agents[1]).toMatchObject({
      title: "Payment tests",
      model: "gpt-test",
      status: "running",
      brief: { source: "sub_agent" },
      capabilities: { brief: false, text: true, end: true, stop: false },
    });
    expect(chat.sub_agents[1]?.brief?.text).toBeUndefined();
  });

  it("puts one row in the main transcript and nothing the sub-agents did", () => {
    const main = items.filter((item) => !item.owner);
    expect(main.filter((item) => item.kind === "sub_agent")).toHaveLength(1);
    expect(main.map((item) => item.kind)).toEqual([
      "user",
      "turn",
      "sub_agent",
    ]);
  });

  it("shows the nested sub-agent with the path back through its parent and the words Codex lacks", () => {
    const view = subAgentView(chat, items, "thr_b", Date.now());
    expect(view?.ancestors.map((agent) => agent.id)).toEqual(["thr_a"]);
    expect(view?.items.map((item) => item.kind)).toEqual(["turn", "steps"]);
    expect(view?.brief.text).toBe(
      "Codex doesn't report what a sub-agent was asked.",
    );
    const outer = subAgentView(chat, items, "thr_a", Date.now());
    expect(outer?.items.map((item) => item.kind)).toEqual([
      "turn",
      "sub_agent",
    ]);
  });
});
