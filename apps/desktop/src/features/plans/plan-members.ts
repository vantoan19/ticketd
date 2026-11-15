import { client, type Ticket } from "@/lib/api/client";

const MEMBER_PAGE = 50;
export async function allPlanMembers(plan: string) {
  const members: Ticket[] = [];
  for (let offset = 0; ; offset += MEMBER_PAGE) {
    const page = await client.findTickets({
      query: "",
      unlinked: false,
      project: null,
      plan,
      status: null,
      tags: [],
      availability: null,
      family: null,
      limit: MEMBER_PAGE,
      offset,
    });
    members.push(...page);
    if (page.length < MEMBER_PAGE) return members;
  }
}
