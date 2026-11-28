import { plansClient, type Plan, type PlanCounts } from "@/lib/api/plans";
import { flowPlanMembers, PlanMemberWindow } from "./plan-members";
import { planWrapUp } from "./plan-work-model";

type PlanIndexDetails = {
  ready: number;
  blocked: number;
  wrapUp: boolean;
  updated: string | null;
};

export type PlanIndexData = {
  counts: PlanCounts | undefined;
  details: PlanIndexDetails | null;
};

/** Counts come from the whole Plan, even when its dependency read is bounded. */
export async function readPlanIndexData(
  plan: Plan,
): Promise<{ data: PlanIndexData; error?: unknown }> {
  const [summary, membership] = await Promise.allSettled([
    plansClient.show(plan.id, 0, 0, false),
    flowPlanMembers(plan.id),
  ]);
  const counts =
    summary.status === "fulfilled" ? summary.value.counts : undefined;
  if (summary.status === "rejected")
    return { data: { counts, details: null }, error: summary.reason };
  if (membership.status === "rejected") {
    if (membership.reason instanceof PlanMemberWindow)
      return { data: { counts, details: null } };
    return {
      data: { counts, details: null },
      error: membership.reason,
    };
  }
  const members = membership.value;
  const total = Object.values(summary.value.counts).reduce((a, b) => a + b, 0);
  if (
    members.length !== total ||
    new Set(members.map((member) => member.reference)).size !== total
  ) {
    return {
      data: { counts, details: null },
      error: new Error(
        "The Plan changed while its member details were loading.",
      ),
    };
  }
  // The member update timestamp includes ticket changes, history and Activities.
  const updated = members.reduce<string | null>((latest, member) => {
    const time = Date.parse(member.updated_at ?? "");
    return Number.isFinite(time) && (!latest || time > Date.parse(latest))
      ? member.updated_at
      : latest;
  }, null);
  return {
    data: {
      counts,
      details: {
        ready: members.filter((member) => member.availability === "Ready")
          .length,
        blocked: members.filter((member) => member.availability === "Blocked")
          .length,
        wrapUp: planWrapUp(plan.archived, members) !== null,
        updated,
      },
    },
  };
}
