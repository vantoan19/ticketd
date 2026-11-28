import { plansClient, type PlanCounts } from "@/lib/api/plans";
import { read, useRead } from "@/lib/workspace-reads";
import { flowPlanMembers, PlanMemberWindow } from "./plan-members";
import { planWrapUp, type PlanWorkTicket } from "./plan-work-model";

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

async function readPlanIndexData(
  id: string,
  archived: boolean,
): Promise<PlanIndexData> {
  const [summary, membership] = await Promise.all([
    plansClient.show(id, 0, 0, false),
    flowPlanMembers(id).catch((reason: unknown) => {
      if (reason instanceof PlanMemberWindow) return null;
      throw reason;
    }),
  ]);
  // Flow bounds its projection. The full Plan read supplies counts and all
  // prerequisites together from one snapshot when the projection omits any.
  const complete = membership === null ? await plansClient.show(id) : null;
  const counts = complete?.counts ?? summary.counts;
  const members = complete?.members ?? membership ?? [];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (
    members.length !== total ||
    new Set(members.map((member) => member.reference)).size !== total
  )
    throw new Error("The Plan changed while its member details were loading.");
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
    counts,
    details: {
      ready: members.filter((member) => member.availability === "Ready").length,
      blocked: members.filter((member) => member.availability === "Blocked")
        .length,
      wrapUp: planWrapUp<PlanWorkTicket>(archived, members) !== null,
      updated,
    },
  };
}

const planIndexRead = read({
  key: "plan-index-row",
  call: ({ id, archived }: { id: string; archived: boolean }) =>
    readPlanIndexData(id, archived),
  failure: "load Plan details",
});

export function usePlanIndexData(id: string, archived: boolean) {
  return useRead(planIndexRead, { id, archived });
}
