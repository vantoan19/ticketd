import { z } from "zod";

/** An external issue ticketd created or may have created. */
const publishedIssueSchema = z.object({
  identity: z.object({ provider: z.string(), id: z.string() }),
  locator: z.string(),
  display: z.string(),
  url: z.string(),
});

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
  issue: publishedIssueSchema.nullable(),
});
export type PublicationAttempt = z.infer<typeof publicationAttemptSchema>;

/**
 * What the core knows about an unresolved attempt, what it cannot know, and the
 * actions that are safe. `candidates_complete` is null when no search ran or it
 * failed (see `lookup_failure`); a failed search is never "nothing found".
 */
export const publicationReviewSchema = z.object({
  attempt: publicationAttemptSchema,
  provider_name: z.string(),
  known: z.array(z.string()),
  unknown: z.string(),
  note: z.string(),
  actions: z.array(
    z.object({
      kind: z.enum(["attach", "not_created"]),
      available: z.boolean(),
      label: z.string(),
      detail: z.string(),
    }),
  ),
  candidates: z.array(publishedIssueSchema),
  candidates_complete: z.boolean().nullable(),
  lookup_failure: z
    .object({ code: z.string(), message: z.string() })
    .nullable(),
});
export type PublicationReview = z.infer<typeof publicationReviewSchema>;

export type PublicationResolution =
  { kind: "attach"; issue: string | null } | { kind: "not_created" };
