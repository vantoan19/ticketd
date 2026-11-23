import { agentName, report, type Stage } from "./workspace";

// Four events from the followed ticket, in the desktop Inbox's newest-first order.
const history = [
  {
    id: "done",
    stage: 3,
    kind: "status",
    from: "In review",
    to: "Done",
    agent: null,
  },
  {
    id: "review",
    stage: 2,
    kind: "status",
    from: "In progress",
    to: "In review",
    agent: agentName,
  },
  { id: "report", stage: 2, kind: "activity", body: report, agent: agentName },
  {
    id: "start",
    stage: 1,
    kind: "status",
    from: "Todo",
    to: "In progress",
    agent: agentName,
  },
] as const;
export type DemoEntry = (typeof history)[number];
export type EntryId = DemoEntry["id"];

export function entriesAt(stage: Stage) {
  return history.filter((change) => change.stage <= stage);
}
export function needsReview(entry: DemoEntry, stage: Stage) {
  return entry.id === "review" && stage === 2;
}
export function summary(entry: DemoEntry, stage: Stage) {
  if (needsReview(entry, stage))
    return agentName + " moved it to In review, waiting for you";
  if (entry.kind === "activity") return entry.agent + ": " + entry.body;
  return (
    "Status " +
    entry.from +
    " → " +
    entry.to +
    (entry.agent ? " · " + entry.agent : "")
  );
}
