import { project, type Position } from "../art/geometry.ts";
import type { Station } from "../art/world-layout.ts";
import type { Focus } from "./captures.ts";

export type Feature = Focus & {
  name: string;
  description: string;
  station: Position;
  command?: string;
};
export function stationPin(feature: Feature, index: number) {
  const [x, y] = project(feature.station);
  return { x, y, rise: index % 2 === 0 ? 26 : 21 };
}
export interface Stop {
  name: Station;
  heading: string;
  body: string;
  mode: "notes" | "commands" | "rules";
  features: readonly [Feature, ...Feature[]];
}

export const stops: readonly Stop[] = [
  {
    name: "Plan",
    heading: "See which ticket is ready.",
    body: "Give a Plan a purpose and a spec. Its flow shows what an AI agent can pick up now, and what depends on that work.",
    mode: "notes",
    features: [
      {
        name: "Ready to start",
        description: "The limiter has no open blockers.",
        region: "ready",
        station: [29, 74, 19],
        screen: "plan",
      },
      {
        name: "Waiting on the limiter",
        description: "The alerting ticket comes next.",
        region: "waiting",
        station: [87, 42, 19],
        screen: "plan",
      },
      {
        name: "A shared spec",
        description: "The Plan keeps the rate-limit requirements close.",
        region: "spec",
        station: [48, 8, 44],
        screen: "plan",
      },
      {
        name: "A smaller piece of work",
        description: "The retry-time ticket is a subticket of the limiter.",
        region: "subticket",
        station: [90, 78, 19],
        screen: "context",
      },
    ],
  },
  {
    name: "Hand off",
    heading: "Give an AI agent the ticket.",
    body: "In Claude Code or Codex, your agent can read the same ticket and report back through the CLI. Try the commands in order.",
    mode: "commands",
    features: [
      {
        name: "Read the context",
        description: "The agent reads the ticket before it starts.",
        command: "ticketd context T-RL12 --plan --documents --relationships",
        region: "purpose",
        station: [21, 18, 36],
        screen: "context",
      },
      {
        name: "Start work",
        description: "The ticket moves to In progress under the agent’s name.",
        command:
          'ticketd change T-RL12 --status "In progress" --agent coding-agent',
        region: "working",
        station: [87, 28, 27],
        screen: "board",
      },
      {
        name: "Post the update",
        description: "The agent leaves an update with the test result.",
        command:
          'ticketd activity add T-RL12 --agent coding-agent --brief "The limiter passes the boundary tests. Ready for review."',
        region: "update",
        station: [22, 18, 36],
        screen: "ticket",
      },
      {
        name: "Ask for review",
        description:
          "The review request reaches the person following the ticket.",
        command:
          'ticketd change T-RL12 --status "In review" --agent coding-agent',
        region: "review",
        station: [135, 15, 43],
        screen: "inbox",
      },
    ],
  },
  {
    name: "Follow",
    heading: "Know when the work needs you.",
    body: "Follow a ticket to see its updates in your Inbox. Open it when the agent asks for review. The work and its evidence are together.",
    mode: "notes",
    features: [
      {
        name: "Needs you",
        description: "The agent moved the limiter to In review.",
        region: "review",
        station: [140, 17, 45],
        screen: "inbox",
      },
      {
        name: "In the agent’s words",
        description: "The boundary tests pass and the change is ready.",
        region: "note",
        station: [62, 33, 19],
        screen: "inbox",
      },
      {
        name: "Earlier activity",
        description:
          "The Inbox also records when the ticket moved into progress.",
        region: "earlier",
        station: [96, 72, 15],
        screen: "inbox",
      },
      {
        name: "The evidence",
        description: "Open the ticket to check the branch and passing tests.",
        region: "verification",
        station: [47, 76, 15],
        screen: "evidence",
      },
    ],
  },
  {
    name: "Automate",
    heading: "Let the routine work run.",
    body: "With experimental Chat enabled, set a trigger and choose what happens next. Each device runs the Automations you switch on there.",
    mode: "rules",
    features: [
      {
        name: "Review notification",
        description:
          "When a ticket reaches In review, send a notification that opens it.",
        region: "notify",
        station: [114, 25, 54],
        screen: "rules",
      },
      {
        name: "Triage security tickets",
        description:
          "Check new tickets for a security tag. Add triage to the ones that match.",
        region: "branch",
        station: [45, 23, 44],
        screen: "rules-triage",
      },
      {
        name: "Weekly review",
        description:
          "On Monday morning, run a review agent and notify you when the run finishes.",
        region: "agent",
        station: [58, 55, 34],
        screen: "rules-weekly",
      },
    ],
  },
];
