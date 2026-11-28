import { describe, expect, it } from "vitest";
import { creditedSubAgentSchema } from "@/lib/api/credit";
import {
  agentName,
  ticketAgentSchema,
  ticketAgentsSchema,
} from "@/features/chats/ticket-agents";
import {
  creditedTests,
  ticketAgentFixtures,
} from "@/features/chats/ticket-agent-fixtures";
import { createMockChatClient } from "@/features/chats/mock-client";

describe("the ticket agents contract", () => {
  it("fills the defaults of a host that sends only what it knows", () => {
    const agent = ticketAgentSchema.parse({
      id: "c1",
      chat_id: "c1",
      chat_title: "A Chat",
      harness_name: "Codex",
      title: "A Chat",
      started_at: "2026-11-27T10:00:00Z",
    });
    expect(agent.retention).toBe("active");
    expect(agent.sub_agent).toBeUndefined();
    expect(agentName(agent)).toBe("Codex");
  });

  it("names an agent by its model, else its harness", () => {
    const { many } = ticketAgentFixtures();
    expect(many.map(agentName)).toEqual([
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
      "GPT-6.2",
      "GPT-6.2 mini",
    ]);
    expect(agentName({ model: " ", harness_name: "Codex" })).toBe("Codex");
  });

  it("builds every state the boards show", () => {
    const fixtures = ticketAgentFixtures();
    expect(fixtures.one).toHaveLength(1);
    expect(fixtures.two).toHaveLength(2);
    expect(fixtures.many).toHaveLength(4);
    expect(fixtures.none).toEqual([]);
    expect(fixtures.approval[0]?.approval?.summary).toBe(
      "npm test -- rate-limit",
    );
    expect(ticketAgentsSchema.safeParse(fixtures.subAgent).success).toBe(true);
  });

  it("reads a credited sub-agent, and none when the host sends none", () => {
    expect(creditedSubAgentSchema.parse(creditedTests).retention).toBe(
      "active",
    );
    expect(creditedSubAgentSchema.nullish().parse(undefined)).toBeUndefined();
  });

  it("serves the mock's agents per ticket, none by default", async () => {
    const { one } = ticketAgentFixtures();
    const client = createMockChatClient({
      enabled: true,
      ticketAgents: { "t-1": one },
    });
    expect(await client.ticketAgents("t-1")).toEqual(one);
    expect(await client.ticketAgents("t-2")).toEqual([]);
    client.setTicketAgents("t-1", []);
    expect(await client.ticketAgents("t-1")).toEqual([]);
  });
});
