/**
 * The ticket statuses and everything keyed by them, in one place. The core owns
 * what each status means; this is only the vocabulary the interface shares.
 */
export const ticketStatuses = [
  "Todo",
  "In progress",
  "In review",
  "Done",
  "Canceled",
  "Duplicate",
] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

/** Workflow order: the order the core pages through and groups are listed in. */
export const workflowStatuses = [
  "In progress",
  "In review",
  "Todo",
  "Done",
  "Canceled",
  "Duplicate",
] as const satisfies readonly TicketStatus[];

/**
 * Statuses a person or agent can choose directly. Duplicate is not among them: marking one
 * needs a canonical ticket, so it goes through the duplicate review instead.
 */
export const directStatuses = ticketStatuses.filter(
  (status) => status !== "Duplicate",
);

/** The field of the core's status counts that holds each status. */
export const statusCountKey = {
  Todo: "todo",
  "In progress": "in_progress",
  "In review": "in_review",
  Done: "done",
  Canceled: "canceled",
  Duplicate: "duplicate",
} as const satisfies Record<TicketStatus, string>;
