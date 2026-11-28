import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "@/features/chats/client";

/**
 * What the Rust host sends of a Codex Chat right after ticketd woke the main agent for the
 * sub-agent that finished first, while the other still runs. `chat_view.rs` builds the file
 * from the host's stored history of `sub_agent_wake_while_another_runs.jsonl`
 * (`sub_agent_wake.stored.json`) and the live state the host has then; the Rust test
 * rewrites it with TICKETD_UPDATE_VIEW_FIXTURES=1 and fails if it changes without it. This
 * test reads it with the schemas the interface parses real data with.
 */
const { chat, items } = chatSnapshotSchema.parse(
  JSON.parse(
    readFileSync(new URL("./codex-wake-view.json", import.meta.url), "utf8"),
  ),
);

describe("the host's view of a wake ticketd sent", () => {
  it("labels the turn as started by ticketd, after the sub-agent that finished, with no message of the person's", () => {
    const turns = items.filter((item) => item.kind === "turn" && !item.owner);
    expect(turns).toHaveLength(2);
    expect(turns[0]).not.toHaveProperty("origin");
    const origin = (turns[1] as { origin?: { by: string; sub_agent?: string } })
      .origin;
    expect(origin?.by).toBe("ticketd");
    const finished = chat.sub_agents.find(
      (agent) => agent.native_id === origin?.sub_agent,
    );
    expect(finished?.title).toBe("Update the refund calls");
    expect(finished?.status).toBe("completed");
    expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
  });

  it("keeps the Chat working with no turn while the other sub-agent runs", () => {
    expect(chat.activity).toBe("working");
    expect(chat.turn_running).toBe(false);
    expect(chat.sub_agents.map((agent) => [agent.title, agent.status])).toEqual(
      [
        ["Update the refund calls", "completed"],
        ["Update the webhook handler", "running"],
      ],
    );
  });
});
