import type { Plan } from "@/lib/api/plans";

export function planAssignmentChoices(
  plans: readonly Pick<Plan, "id" | "name" | "archived">[],
  current: string | null,
) {
  return [
    ...plans
      .filter((plan) => !plan.archived)
      .map((plan) => ({
        value: plan.id,
        label: plan.name,
        selected: plan.id === current,
      })),
    { value: "", label: "No Plan", selected: current === null },
  ];
}
