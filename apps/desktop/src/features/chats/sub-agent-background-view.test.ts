import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "@/features/chats/client";

/**
 * What the Rust host sends of a Claude Chat whose background sub-agents keep working after
 * the main agent's turn ended, at four moments. `chat_view.rs` builds each file from the
 * host's stored history of `sub_agent_background.jsonl` (`sub_agent_background_*.stored.json`)
 * and the live state the host has then; the Rust test rewrites them with
 * TICKETD_UPDATE_VIEW_FIXTURES=1 and fails if they change without it. This test reads them
 * with the schemas the interface parses real data with.
 */
const view = (moment: string) =>
  chatSnapshotSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`./claude-background-${moment}-view.json`, import.meta.url),
        "utf8",
      ),
    ),
  );

describe("the host's view of background sub-agents", () => {
  it("while two work: the Chat works with no turn, and the strip's data is in the state", () => {
    const { chat, items } = view("working");
    expect(chat.activity).toBe("working");
    expect(chat.turn_running).toBe(false);
    expect(chat.doing).toBeNull();
    expect(chat.sub_agents.map((agent) => [agent.title, agent.status])).toEqual(
      [
        ["Find limiter bypasses", "running"],
        ["Check limiter test coverage", "running"],
        // It finished in the turn that started it.
        ["Proofread the API docs", "completed"],
      ],
    );
    // The turn that started them ended, and their own steps stay theirs.
    const turns = items.filter((item) => item.kind === "turn" && !item.owner);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ outcome: "completed" });
    expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
    // The main agent's one command, and none of the sub-agents' reads.
    expect(
      items.flatMap((item) =>
        item.kind === "steps" && !item.owner
          ? item.steps.map((step) => step.kind)
          : [],
      ),
    ).toEqual(["run"]);
    expect(
      items.filter((item) => item.kind === "steps" && item.owner),
    ).not.toHaveLength(0);
  });

  it("inside the turn that started them: the turn works, with a plan, and the strip's data is there too", () => {
    const { chat, items } = view("in_turn");
    expect(chat.activity).toBe("working");
    expect(chat.turn_running).toBeUndefined();
    expect(
      items.filter((item) => item.kind === "turn" && !item.owner),
    ).toMatchObject([{ outcome: "active" }]);
    expect(items.filter((item) => item.kind === "plan")).toHaveLength(1);
    expect(
      chat.sub_agents.filter((agent) => agent.status === "running"),
    ).toHaveLength(2);
  });

  it("when one has finished, one is left", () => {
    const { chat } = view("one");
    expect(chat.turn_running).toBe(false);
    expect(chat.sub_agents.map((agent) => agent.status)).toEqual([
      "running",
      "completed",
      "completed",
    ]);
  });

  it("once Claude resumed by itself: a turn nobody asked for, and the Chat is quiet", () => {
    const { chat, items } = view("done");
    expect(chat.activity).toBe("idle");
    expect(chat.turn_running).toBeUndefined();
    const turns = items.flatMap((item) =>
      item.kind === "turn" && !item.owner ? [item] : [],
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]?.origin).toBeUndefined();
    expect(turns[1]?.origin).toEqual({
      by: "harness",
      sub_agent: "task_a",
    });
    // It has no message of the person's: the line "Started by Claude Code" stands for it.
    const second = turns[1]?.turn_id;
    expect(
      items.filter((item) => item.kind === "user" && item.turn_id === second),
    ).toEqual([]);
    expect(chat.sub_agents.every((agent) => agent.status === "completed")).toBe(
      true,
    );
  });

  it("after Stop with no turn: the sub-agents are stopped by the person and the Chat says how many", () => {
    const { chat, items } = view("stopped");
    expect(chat.activity).toBe("idle");
    expect(
      chat.sub_agents.map((agent) => [agent.status, agent.stopped_by]),
    ).toEqual([
      ["stopped", "person"],
      ["stopped", "person"],
      ["completed", undefined],
    ]);
    expect(
      items.filter(
        (item) =>
          item.kind === "marker" && item.reason === "sub_agents_stopped",
      ),
    ).toMatchObject([{ count: 2 }]);
  });
});
