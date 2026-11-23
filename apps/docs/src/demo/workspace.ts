export const featureRef = "T-RL12";
export const dependentRef = "T-RL13";

export const stages = [
  {
    label: "Plan it",
    status: "Todo",
    worldDescription: `A cart waits beside the Plan table with the blue ticket ${featureRef}.`,
    caption: `${featureRef} is ready. The alerting ticket waits for the limiter.`,
  },
  {
    label: "Hand it off",
    status: "In progress",
    worldDescription: `The cart has brought ${featureRef} to the agent dock.`,
    caption: `${featureRef} moves to In progress under coding-agent’s name.`,
  },
  {
    label: "See the update",
    status: "In review",
    worldDescription: `The cart stops at the Inbox with ${featureRef} ready for review.`,
    caption: "The tests pass. An update and a review request reach your Inbox.",
  },
  {
    label: "Approve",
    status: "Done",
    worldDescription: `The cart has unloaded ${featureRef} onto the Done stack.`,
    caption: `${featureRef} is Done. ${dependentRef} is ready to start.`,
  },
] as const;
export type Stage = 0 | 1 | 2 | 3;
export type Status = (typeof stages)[number]["status"];
export const planName = "API rate limits";
export const specTitle = planName + " spec";
export const agentName = "coding-agent";
export const report =
  "The limiter passes the boundary tests. Ready for review.";
export const specification =
  "Protect the API from request bursts. Count requests inside a sliding window, report the result, and tell clients when they can try again.";

export const featuredTicket = {
  reference: featureRef,
  title: "Rate-limit API requests",
  status: "Todo",
  body: "Limit request bursts and let clients retry after the window closes.",
} as const;

const seed = [
  {
    reference: "T-RL9",
    title: "Log rejected requests",
    status: "In review",
    body: "Record a rejected request without storing its payload.",
  },
  {
    reference: "T-RL10",
    title: "Exercise the alert path",
    status: "Todo",
    body: "Check that repeated rejections reach the person on call.",
  },
  {
    reference: "T-RL11",
    title: "Add an audit event",
    status: "Done",
    body: "Record the outcome of a limited request.",
  },
  featuredTicket,
  {
    reference: dependentRef,
    title: "Alert on repeated failures",
    status: "Todo",
    body: "Use the limiter events to alert the person on call.",
  },
  {
    reference: "T-RL14",
    title: "Show the retry time",
    status: "In progress",
    body: "Tell clients when they can send requests again.",
  },
] as const;

export function demoTickets(stage: Stage) {
  const tickets = seed.map((ticket) => ({
    ...ticket,
    status:
      ticket.reference === featureRef ? stages[stage].status : ticket.status,
  }));
  return tickets.map((ticket) => {
    const factor =
      ticket.reference === dependentRef
        ? featureRef
        : ticket.reference === "T-RL10"
          ? dependentRef
          : null;
    const prerequisite = tickets.find((t) => t.reference === factor);
    const unresolved =
      prerequisite !== undefined && prerequisite.status !== "Done";
    return {
      ...ticket,
      blocker: unresolved ? prerequisite.reference : null,
      editingAgent:
        ticket.reference === featureRef && (stage === 1 || stage === 2)
          ? agentName
          : null,
      availability:
        ticket.status === "Todo" ? (unresolved ? "Blocked" : "Ready") : null,
      prerequisites: prerequisite
        ? [
            {
              reference: prerequisite.reference,
              title: prerequisite.title,
              status: prerequisite.status,
              trashed: false,
              unresolved,
            },
          ]
        : [],
    };
  });
}
export type DemoTicket = ReturnType<typeof demoTickets>[number];
export function planCounts(tickets: DemoTicket[]) {
  const count = (s: Status) => tickets.filter((t) => t.status === s).length;
  return {
    todo: count("Todo"),
    in_progress: count("In progress"),
    in_review: count("In review"),
    done: count("Done"),
    canceled: 0,
    duplicate: 0,
  };
}
export function nextStage(stage: Stage): Stage {
  return ([1, 2, 3, 0] as const)[stage];
}
