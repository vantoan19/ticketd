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

/** One line describing what a choice does to the ticket that waits on the edge. */
export function consequence(
  source: string,
  edge: DependencyEdge,
  choice: Choice,
): string {
  if (edge.blocker === source) {
    if (choice === "replace")
      return `${edge.dependent} waits for ${edge.replacement_blocker} to be Done instead`;
    if (choice === "remove")
      return `${edge.dependent} no longer waits on ${source}`;
    return `${edge.dependent} stays blocked by a canceled ticket`;
  }
  if (choice === "replace")
    return `${edge.replacement_dependent} waits for ${edge.blocker} to be Done`;
  if (choice === "remove") return `${edge.blocker} no longer blocks ${source}`;
  return `${source} keeps its dependency on ${edge.blocker}`;
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
