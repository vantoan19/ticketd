import { z } from "zod";

/**
 * The sub-agent a ticket's Activity or status change is credited to, on this
 * computer. Chats do not sync, so the host sends it only where it knows the
 * Chat; elsewhere the field is absent and only the author shows.
 */
export const creditedSubAgentSchema = z.object({
  chat_id: z.string(),
  retention: z.enum(["active", "archived", "trashed"]).default("active"),
  /** The SubAgent.id in that Chat. */
  sub_agent: z.string(),
  title: z.string(),
});
export type CreditedSubAgent = z.infer<typeof creditedSubAgentSchema>;
