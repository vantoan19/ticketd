import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "@/features/chats/client";
import { subAgentView } from "@/features/chats/sub-agents";

/**
 * What the Rust host sends for an Antigravity sub-agent after its Prompt ended: the view
 * `chat_view.rs` builds from the stored history of `sub_agent.jsonl` (converted from a live
 * agy 1.5.17 capture). The Rust test writes the file (TICKETD_UPDATE_VIEW_FIXTURES=1) and
 * fails if it changes without it; this test reads it with the schemas the interface parses
 * real data with.
 */
const sent = JSON.parse(
  readFileSync(
    new URL("./antigravity-sub-agent-view.json", import.meta.url),
    "utf8",
  ),
) as unknown;

describe("the host's view of an Antigravity sub-agent", () => {
  const { chat, items } = chatSnapshotSchema.parse(sent);
  const agent = chat.sub_agents[0]!;

  it("parses with the interface's own schemas and says what Antigravity does not report", () => {
    expect(chat.sub_agents).toHaveLength(1);
    expect(agent).toMatchObject({
      title: "Session Auditor",
      status: "completed",
      brief: { source: "main_agent" },
      capabilities: {
        brief: true,
        text: false,
        end: false,
        stop: false,
        resume: false,
      },
    });
    expect(agent.brief?.text).toMatch(/^Scan the session routes in src\/auth/);
  });

  it("puts one row in the main transcript and the sub-agent's command in its own view", () => {
    const main = items.filter((item) => !item.owner);
    expect(main.filter((item) => item.kind === "sub_agent")).toHaveLength(1);
    expect(
      items.filter((item) => item.owner === agent.id && item.kind === "steps"),
    ).toHaveLength(1);
    const view = subAgentView(chat, items, agent.id, Date.now());
    expect(view?.limits).toBe(true);
    expect(view?.brief.reported).toBe(true);
    expect(view?.ending).toBeNull();
    // Its command's approval, answered, is the sub-agent's own (folded into the Step), not
    // the main agent's.
    expect(view?.items.map((item) => item.kind)).toEqual([
      "turn",
      "steps",
      "request",
    ]);
    expect(main.some((item) => item.kind === "request")).toBe(false);
  });
});
