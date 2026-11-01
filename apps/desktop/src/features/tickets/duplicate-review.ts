import type {
  DependencyDecision,
  DependencyEdge,
  DuplicatePreview,
  WaitingOutcome,
} from "@/lib/api/client";

export type Choice = DependencyDecision["choice"];
export type ReplacementIssue = NonNullable<
  DuplicatePreview["replacement_issues"][number]
>;

export const choiceLabels: Record<Choice, string> = {
  replace: "Replace",
  remove: "Remove",
  retain: "Keep",
};

/** Why Replace is unavailable for an edge, in the words the review shows. */
export function replacementIssueReason(
  edge: DependencyEdge,
  issue: ReplacementIssue,
): string {
  switch (issue) {
    case "already_exists":
      return `${edge.replacement_blocker} already blocks ${edge.replacement_dependent}`;
    case "self_block":
      return `it would make ${edge.replacement_dependent} block itself`;
    case "cycle":
      return `it would create a dependency cycle`;
    case "trashed":
      return `${edge.replacement_blocker} or ${edge.replacement_dependent} is in the trash`;
  }
}

/**
 * One line describing what a choice does to the ticket that waits on the edge.
 * `outcomes` come from the core, which judges every choice together, so this only
 * words them. In a separate review the existing endpoint is not canceled, so Keep
 * leaves a live dependency rather than one on a canceled ticket.
 */
export function consequence(
  source: string,
  edge: DependencyEdge,
  choice: Choice,
  outcomes: WaitingOutcome[],
  separate = false,
): string {
  const waiting =
    choice === "replace" ? edge.replacement_dependent : edge.dependent;
  const outcome = outcomes.find((candidate) => candidate.ticket === waiting);
  const added = edge.replacement_blocker;
  // What the choice does to the dependency, with the subject named or not.
  const effect = (subject: string) => {
    if (edge.blocker === source) {
      if (choice === "replace") {
        const done = outcome && !outcome.unresolved_after.includes(added);
        return `${subject} now waits on ${added}${done ? ", which is Done" : ""}`;
      }
      if (choice === "remove") return `${subject} no longer waits on ${source}`;
      return separate
        ? `${subject} keeps waiting on ${source}`
        : `${subject} keeps waiting on a canceled ticket`;
    }
    if (choice === "replace")
      return `${subject} takes over ${source}'s dependency on ${edge.blocker}`;
    if (choice === "remove")
      return `${edge.blocker} no longer blocks ${source}`;
    return `${waiting === source ? subject : source} keeps its dependency on ${edge.blocker}`;
  };
  if (!outcome) return effect(waiting);
  const { unresolved_after: unresolved } = outcome;
  if (waiting === source && !separate)
    return `${waiting} is Canceled and has no Ready state; ${effect("it")}`;
  if (outcome.after === "no_ready_state")
    return `${waiting} is ${outcome.trashed ? "in the trash" : outcome.status} and has no Ready state; ${effect("it")}`;
  if (outcome.after === "ready")
    return `${waiting} ${outcome.before === "ready" ? "stays" : "becomes"} Ready; ${effect("it")}`;
  // Blocked afterwards. Name the replacement once: either as the one thing left to wait
  // for, or in the list of what is still unresolved.
  const mentionsAdded = choice === "replace" && unresolved.includes(added);
  if (mentionsAdded && unresolved.length === 1)
    return outcome.before === "ready"
      ? `${waiting} becomes Blocked until ${added} is Done`
      : `${waiting} becomes Ready once ${added} is Done`;
  const state = `${waiting} ${outcome.before === "blocked" ? "stays" : "becomes"} Blocked, waiting on ${unresolved.join(", ")}`;
  return mentionsAdded ? state : `${state}; ${effect("it")}`;
}

/** The number of dependency changes the current choices apply; Keep changes nothing. */
export function changeCount(choices: string[]): number {
  return choices.filter((choice) => choice === "replace" || choice === "remove")
    .length;
}

/** The apply button's label for the current choices. */
export function applyLabel(choices: string[]): string {
  const count = changeCount(choices);
  if (count === 0) return "Mark duplicate";
  return `Mark duplicate and apply ${count} ${count === 1 ? "change" : "changes"}`;
}

/** The sentence that summarizes everything the apply button will do. */
export function summarize(
  source: string,
  canonical: string,
  choices: string[],
): string {
  const tally = (choice: string) =>
    choices.filter((value) => value === choice).length;
  const parts = [
    `Cancel ${source} as a duplicate of ${canonical}`,
    ...(
      [
        ["replace", "replace"],
        ["remove", "remove"],
        ["retain", "keep"],
      ] as const
    )
      .filter(([choice]) => tally(choice) > 0)
      .map(([choice, verb]) => {
        const count = tally(choice);
        return `${verb} ${count} ${count === 1 ? "dependency" : "dependencies"}`;
      }),
  ];
  return `${parts.join(", ")}. All of it is applied together or not at all.`;
}
