import { describe, expect, it } from "vitest";
import {
  chatSnapshotSchema,
  chatStateSchema,
  transcriptItemSchema,
} from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";
import {
  antigravityChat,
  codexChat,
  failedChat,
  subAgentFixtures,
} from "@/features/chats/sub-agent-fixtures";

describe("the sub-agent view-model contract", () => {
  it("reads data from a host that sends no sub-agents exactly as before", () => {
    const item = transcriptItemSchema.parse({
      id: "i1",
      at: "2026-11-27T10:00:00Z",
      turn_id: "t1",
      kind: "response",
      text: "Hello",
      state: "complete",
    });
    expect(item.owner).toBeUndefined();
    const chat = chatStateSchema.parse({
      id: "c1",
      title: "A Chat",
      harness: { id: "codex", name: "Codex" },
      folder: {
        path: "~/code",
        name: "code",
        managed: false,
        missing: false,
        shared_with: [],
      },
      retention: "active",
      activity: "idle",
      steering: { available: true },
      links: [],
      queue: [],
      queue_paused: false,
      unseen: false,
      muted: false,
      has_composer: true,
    });
    expect(chat.sub_agents).toEqual([]);
  });

  it("fills a sub-agent's defaults: one run, a full-featured harness", () => {
    const chat = chatStateSchema.parse({
      ...subAgentFixtures().running.chat,
      sub_agents: [
        {
          id: "sa-1",
          title: "Find limiter bypasses",
          status: "running",
          started_at: "2026-11-27T10:00:00Z",
        },
      ],
    });
    expect(chat.sub_agents[0]).toMatchObject({
      runs: 1,
      capabilities: { brief: true, text: true, end: true, stop: false },
    });
  });

  it("every fixture state is valid contract data and opens in the mock client", async () => {
    const all = [
      ...Object.values(subAgentFixtures()),
      failedChat(),
      codexChat(),
      antigravityChat(),
    ];
    for (const { chat, items } of all) {
      const client = createMockChatClient({
        enabled: true,
        chats: [{ chat, items: items ?? [] }],
      });
      const snapshot = await client.openChat(chat.id);
      expect(chatSnapshotSchema.parse(snapshot).items).toHaveLength(
        items?.length ?? 0,
      );
      // Each sub-agent's own items are owned by it, and every row names a record.
      const ids = new Set(snapshot.chat.sub_agents.map((one) => one.id));
      for (const item of snapshot.items) {
        if (item.kind === "sub_agent") expect(ids).toContain(item.sub_agent);
        if (item.owner) expect(ids).toContain(item.owner);
      }
    }
  });

  it("a nested sub-agent's row sits in its parent's run, not the main turn", () => {
    const { items } = codexChat();
    const nested = items?.find(
      (item) => item.kind === "sub_agent" && item.sub_agent === "sa-pay-tests",
    );
    expect(nested).toMatchObject({
      owner: "sa-refunds",
      turn_id: "sa-refunds:run-1",
    });
    // The parent's run is a turn the parent owns, so the row's run exists.
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "turn",
        owner: "sa-refunds",
        turn_id: "sa-refunds:run-1",
      }),
    );
  });

  it("the replied fixture counts as working while sub-agents run with no main turn", async () => {
    const { replied, finished } = subAgentFixtures();
    expect(replied.chat).toMatchObject({
      activity: "working",
      turn_running: false,
    });
    expect(finished.chat.activity).toBe("idle");
    const client = createMockChatClient({ enabled: true, chats: [replied] });
    expect((await client.overview()).working).toBe(1);
  });
});
