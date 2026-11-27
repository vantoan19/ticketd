import { z } from "zod";
import { retentionSchema } from "@/features/chats/client";

/**
 * The agents at work on one ticket (T-UB271 reads it, T-UB238 supplies it).
 * Nothing here is a harness wire format: the host decides who counts, and the
 * ticket's label only words and opens what it is told.
 *
 * Who counts: the main agent of a Chat linked to the ticket while its turn runs,
 * and any agent (main or sub-agent) with a credited write on the ticket while it
 * runs. The list is sent in display order: an agent waiting for approval first,
 * then Chat by Chat (the most recently active first), each Chat's main agent
 * before its sub-agents, oldest start first. The ticket never reorders it.
 */
export const ticketAgentSchema = z.object({
  /** Unique in the list: the Chat's id, or "{chat id}:{sub-agent id}". Names the row for keys and focus. */
  id: z.string(),
  chat_id: z.string(),
  /** Which Chat list the Chat is in; opening it selects that list. */
  retention: retentionSchema.default("active"),
  chat_title: z.string(),
  /** The SubAgent.id in that Chat. Absent: the main agent. */
  sub_agent: z.string().nullish(),
  harness_id: z.string().nullish(),
  harness_name: z.string(),
  /** The model as the harness's display name ("Claude Sonnet 5.5"). Absent: the harness name is the agent's name. */
  model: z.string().nullish(),
  /** The sub-agent's title, or the Chat's title for the main agent. */
  title: z.string(),
  /** When the work the clock counts began: the turn's start (main agent) or the run's start (sub-agent). */
  started_at: z.string(),
  /** A main agent's current step in words ("Waiting for 2 sub-agents", "Running npm test"). Not read for a sub-agent: its title is its line. */
  doing: z.string().nullish(),
  /** A request waiting for the person: `summary` is the command (or subject) it asks to run. */
  approval: z.object({ summary: z.string() }).nullish(),
});
export type TicketAgent = z.infer<typeof ticketAgentSchema>;
/** What a host may send: the defaults are filled in on parsing. */
export type TicketAgentInput = z.input<typeof ticketAgentSchema>;
export const ticketAgentsSchema = z.array(ticketAgentSchema);

/** What the agent is called on the ticket: its model, else the harness. */
export const agentName = (agent: Pick<TicketAgent, "model" | "harness_name">) =>
  agent.model?.trim() || agent.harness_name;
