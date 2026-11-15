import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";

/** Creation committed, but initial dependency links still need an idempotent retry. */
export class TicketLinksIncomplete extends Error {
  readonly failure: FailureDescription;
  constructor(reference: string, cause: unknown) {
    super(
      `${reference} was created, but its blocking dependencies are incomplete.`,
      { cause },
    );
    const failure = describeFailure(cause, "link the blocking dependencies");
    this.failure = {
      ...failure,
      sentence: `${reference} was created. Some blocking dependencies still need to be linked. Retry safely to finish this ticket.`,
    };
  }
}
