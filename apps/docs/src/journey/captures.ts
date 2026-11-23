import measured from "../../screens/regions.json" with { type: "json" };

type Capture = {
  title: string;
  alt: string;
} & (
  | { frame: "diagram" }
  | {
      /** Starting crop in CSS pixels of the 1280 by 740 desktop window. */
      frame: readonly [x: number, y: number, width: number];
      phoneWidth: number;
    }
);
export const captures = {
  done: {
    title: "Completed board",
    alt: "T-LG12 is in Done alongside the audit event. T-LG13 now has no open blockers.",
    frame: [230, 95, 1030],
    phoneWidth: 312,
  },
  evidence: {
    title: "Implementation evidence",
    alt: "The review ticket records the limiter branch and its passing boundary tests.",
    frame: [750, 262, 530],
    phoneWidth: 304,
  },
  plan: {
    title: "Plan flow",
    alt: "Login hardening in Flow view. Rate-limit failed logins is ready in Now and blocks the alerting ticket in Next.",
    frame: [230, 0, 1050],
    phoneWidth: 316,
  },
  context: {
    title: "Ticket detail",
    alt: "The Todo ticket shows its purpose, a linked Document and the work it blocks.",
    frame: [750, 144, 530],
    phoneWidth: 320,
  },
  board: {
    title: "Plan board",
    alt: "The login limiter sits in In progress on the Login hardening board.",
    frame: [230, 120, 1050],
    phoneWidth: 296,
  },
  ticket: {
    title: "Ticket detail",
    alt: "The ticket in progress has an update from coding-agent, linked work, and implementation evidence.",
    frame: [732, 140, 548],
    phoneWidth: 320,
  },
  inbox: {
    title: "Inbox",
    alt: "Needs you contains a review request for the followed ticket. Updates contains the agent’s note and the earlier status change.",
    frame: [226, 0, 815],
    phoneWidth: 312,
  },
  rules: {
    title: "Review notification",
    alt: "An enabled Automation connects a change to In review to a Notify me step that opens the ticket.",
    frame: "diagram",
  },
  "rules-triage": {
    title: "Triage security tickets",
    alt: "When a ticket is created, an If checks for the security tag. Its Yes branch adds the triage tag.",
    frame: "diagram",
  },
  "rules-weekly": {
    title: "Weekly review",
    alt: "A weekly schedule runs Review agent and sends a notification when the review is ready.",
    frame: "diagram",
  },
} as const satisfies Record<keyof typeof measured.screens, Capture>;
export type Screen = keyof typeof captures;

export interface Region {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
}
export type Focus = {
  [S in Screen]: { screen: S; region: keyof (typeof measured.screens)[S] };
}[Screen];

export function viewportOf(screen: Screen, compact: boolean) {
  return compact ? measured.compact[screen].viewport : measured.viewport;
}
export function regionOf(focus: Focus, compact = false): Region {
  const regions: Record<string, Region> = compact
    ? measured.compact[focus.screen].regions
    : measured.screens[focus.screen];
  return regions[focus.region]!;
}
