import type {
  DependencyDecision,
  DependencyEdge,
  DuplicatePreview,
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
  }
}

/**
 * One line describing what a choice does to the ticket that waits on the edge.
 * In a separate review the existing endpoint is not canceled, so Keep leaves a
 * live dependency rather than one on a canceled ticket. Whether the waiting
 * ticket is Ready afterwards is the core's answer; this only words it.
 */
export function consequence(
  source: string,
  edge: DependencyEdge,
  choice: Choice,
  separate = false,
): string {
  if (edge.blocker === source) {
    const effect =
      choice === "replace"
        ? `it waits for ${edge.replacement_blocker} to be Done instead`
        : choice === "remove"
          ? `it no longer waits on ${source}`
          : separate
            ? `it keeps waiting on ${source}`
            : "it keeps waiting on a canceled ticket";
    const ready = {
      replace: edge.ready_if_replaced,
      remove: edge.ready_if_removed,
      retain: edge.ready_if_kept,
    }[choice];
    return `${readiness(edge, ready)}; ${effect}`;
  }
  if (choice === "replace")
    return `${edge.replacement_dependent} waits for ${edge.blocker} to be Done`;
  if (choice === "remove") return `${edge.blocker} no longer blocks ${source}`;
  return `${source} keeps its dependency on ${edge.blocker}`;
}

/** How a choice changes whether the dependent is Ready; only Todo tickets have a Ready state. */
function readiness(edge: DependencyEdge, ready: boolean): string {
  if (edge.dependent_status !== "Todo")
    return `${edge.dependent} is ${edge.dependent_status} and has no Ready state`;
  const verb = ready === edge.dependent_ready ? "stays" : "becomes";
  return `${edge.dependent} ${verb} ${ready ? "Ready" : "Blocked"}`;
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
