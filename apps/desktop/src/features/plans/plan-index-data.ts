import {
  plansClient,
  type Plan,
  type PlanCounts,
  type View,
} from "@/lib/api/plans";
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
  if (summary.status === "rejected")
    return {
      data: { counts: undefined, details: null },
      error: summary.reason,
    };
  let { counts } = summary.value;
  let members: View["members"] | Awaited<ReturnType<typeof flowPlanMembers>>;
  if (membership.status === "fulfilled") {
    members = membership.value;
  } else if (membership.reason instanceof PlanMemberWindow) {
    // Flow bounds its projection. The full Plan read supplies counts and
    // all prerequisites together from one snapshot when that projection omits any.
    try {
      ({ counts, members } = await plansClient.show(plan.id));
    } catch (error) {
      return { data: { counts, details: null }, error };
    }
  } else {
    return { data: { counts, details: null }, error: membership.reason };
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
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
    const updatedAt = member.updated_at;
    if (!updatedAt) return latest;
    const time = Date.parse(updatedAt);
    return Number.isFinite(time) && (!latest || time > Date.parse(latest))
      ? updatedAt
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
