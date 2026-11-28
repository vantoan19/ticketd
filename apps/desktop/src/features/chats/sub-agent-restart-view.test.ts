import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";

/**
 * What the Rust host sends of a Claude Chat after ticketd restarted with background
 * sub-agents running, and after the person's next message (`chat_view.rs` builds each file
 * from the host's stored history of `sub_agent_restart*.stored.json`). This test reads them
 * with the schemas the interface parses real data with.
 */
const view = (moment: string) =>
  chatSnapshotSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`./claude-${moment}-view.json`, import.meta.url),
        "utf8",
      ),
    ),
  );

describe("the host's view after a restart", () => {
  it("holds the notice for the two sub-agents that lost contact, and the third finished", () => {
    const { chat } = view("restart");
    expect(chat.restart_notice).toEqual({
      sub_agents: ["task_a", "task_b"],
      resume: true,
    });
    expect(chat.sub_agents.map((agent) => [agent.id, agent.status])).toEqual([
      ["task_a", "lost"],
      ["task_b", "lost"],
      ["task_c", "completed"],
    ]);
    expect(chat.activity).toBe("idle");
  });

  it("after the next message the notice is gone, the message shows exactly the note and both run again", () => {
    const { chat, items } = view("restart_sent");
    expect(chat.restart_notice).toBeFalsy();
    const noted = items.filter(
      (item) => item.kind === "user" && item.note?.kind === "lost_sub_agents",
    );
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({
      text: "Pick the two reviews back up.",
      note: {
        sub_agents: ["task_a", "task_b"],
        text: expect.stringContaining("You can resume them."),
      },
    });
    // The same record, a second run: one row for each run, and the Step that resumed it is
    // not a row of the main agent's.
    expect(
      chat.sub_agents.map((agent) => [agent.id, agent.status, agent.runs]),
    ).toEqual([
      ["task_a", "running", 2],
      ["task_b", "running", 2],
      ["task_c", "completed", 1],
    ]);
    const rows = items.filter(
      (item) => item.kind === "sub_agent" && item.sub_agent === "task_a",
    );
    expect(rows.map((row) => row.kind === "sub_agent" && row.run)).toEqual([
      1, 2,
    ]);
    expect(
      items.flatMap((item) =>
        item.kind === "steps" && !item.owner
          ? item.steps.map((step) => step.kind)
          : [],
      ),
    ).toEqual(["run"]);
  });
});

describe("the Chats list for a Chat holding the notice", () => {
  it("says how many sub-agents lost contact, muted and without a dot", async () => {
    const { chat } = view("restart");
    const client = createMockChatClient({
      enabled: true,
      chats: [{ chat: { ...chat, unseen: false }, items: [] }],
    });
    const rows = await client.listChats("active");
    const status = rows[0]?.status;
    expect(status).toMatchObject({
      rank: "idle",
      word: "2 sub-agents lost contact",
      unseen: false,
    });
  });
});
