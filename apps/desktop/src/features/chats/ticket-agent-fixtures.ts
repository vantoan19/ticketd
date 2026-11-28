import {
  ticketAgentsSchema,
  type TicketAgent,
} from "@/features/chats/ticket-agents";

const ago = (now: number, seconds: number) =>
  new Date(now - seconds * 1000).toISOString();

/**
 * The agents on one ticket in every state the design's boards show (ticket-one,
 * ticket-subagent, ticket-two, ticket-many, ticket-approval), parsed through
 * the contract's schema. The demo texts are the boards'.
 */
export function ticketAgentFixtures(now = Date.now()) {
  const opus = {
    id: "c-limiter",
    chat_id: "c-limiter",
    chat_title: "Review the rate limiter",
    harness_id: "claude-code",
    harness_name: "Claude Code",
    model: "Claude Opus 5.5",
    title: "Review the rate limiter",
    started_at: ago(now, 91),
    doing: "Waiting for 2 sub-agents",
  };
  const sonnet = {
    id: "c-limiter:sa-tests",
    chat_id: "c-limiter",
    chat_title: "Review the rate limiter",
    sub_agent: "sa-tests",
    harness_id: "claude-code",
    harness_name: "Claude Code",
    model: "Claude Sonnet 5.5",
    title: "Check limiter test coverage",
    started_at: ago(now, 130),
  };
  const gpt = {
    id: "c-sdk",
    chat_id: "c-sdk",
    chat_title: "Add rate-limit headers to the SDK",
    harness_id: "codex",
    harness_name: "Codex",
    model: "GPT-6.2",
    title: "Add rate-limit headers to the SDK",
    started_at: ago(now, 240),
    doing: "Running npm test",
  };
  const mini = {
    id: "c-sdk:sa-docs",
    chat_id: "c-sdk",
    chat_title: "Add rate-limit headers to the SDK",
    sub_agent: "sa-docs",
    harness_id: "codex",
    harness_name: "Codex",
    model: "GPT-6.2 mini",
    title: "Update the SDK docs",
    started_at: ago(now, 120),
  };
  const parse = (agents: unknown[]): TicketAgent[] =>
    ticketAgentsSchema.parse(agents);
  return {
    /** The main agent alone, waiting for its sub-agents. */
    one: parse([opus]),
    /** A sub-agent alone (its main agent's turn has ended). */
    subAgent: parse([sonnet]),
    two: parse([opus, sonnet]),
    /** Four agents: the first is named, the other three are "3 others". */
    many: parse([opus, sonnet, gpt, mini]),
    /** A sub-agent asks to run a command. */
    approval: parse([
      { ...sonnet, approval: { summary: "npm test -- rate-limit" } },
    ]),
    /** What no host data means: nobody is working. */
    none: parse([]),
  };
}

/** The sub-agent an Activity or status change is credited to (board ticket-credit). */
export const creditedTests = {
  chat_id: "c-limiter",
  sub_agent: "sa-tests",
  title: "Check limiter test coverage",
} as const;
