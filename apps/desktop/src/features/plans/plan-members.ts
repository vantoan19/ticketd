import { client, type FlowTicketMetadata } from "@/lib/api/client";

const MEMBER_PAGE = 50;
const MEMBER_LIMIT = 500;
export class PlanMemberWindow extends Error {
  constructor() {
    super(
      "This Plan exceeds the complete Flow metadata window. Some membership or prerequisite details are unavailable.",
    );
  }
}
/** Complete bounded Flow input, with an explicit refusal on omitted prerequisites. */
export async function flowPlanMembers(plan: string) {
  const members: FlowTicketMetadata[] = [];
  for (let offset = 0; offset <= MEMBER_LIMIT; offset += MEMBER_PAGE) {
    const page = await client.findFlowMetadata({
      query: "",
      unlinked: false,
      project: null,
      plan,
      status: null,
      tags: [],
      availability: null,
      family: null,
      limit: Math.min(MEMBER_PAGE, MEMBER_LIMIT - offset + 1),
      offset,
    });
    if (page.omitted || members.length + page.items.length > MEMBER_LIMIT)
      throw new PlanMemberWindow();
    members.push(...page.items);
    if (page.items.length < MEMBER_PAGE) return members;
  }
  throw new PlanMemberWindow();
}
