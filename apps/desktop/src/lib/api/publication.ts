import { z } from "zod";

/**
 * One try at creating an external issue for a local ticket. `in_flight` and
 * `unresolved` mean the issue may exist and block publishing again.
 */
export const publicationAttemptSchema = z.object({
  id: z.string(),
  reference: z.string(),
  provider: z.string(),
  destination: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["in_flight", "unresolved", "failed", "succeeded"]),
  started_at: z.string(),
  updated_at: z.string(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** The created issue, when ticketd saw it but could not attach it. */
  issue: z
    .object({
      identity: z.object({ provider: z.string(), id: z.string() }),
      locator: z.string(),
      display: z.string(),
      url: z.string(),
    })
    .nullable(),
});
export type PublicationAttempt = z.infer<typeof publicationAttemptSchema>;
