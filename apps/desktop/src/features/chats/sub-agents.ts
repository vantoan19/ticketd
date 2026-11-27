import type {
  ChatState,
  SubAgent,
  TranscriptItem,
} from "@/features/chats/client";
import {
  SUB_AGENT_ENDS_WITH_TURN,
  SUB_AGENT_WORDS,
  turns,
  type TranscriptPart,
} from "@/features/chats/model";

/** One step of the path into a sub-agent's view: the sub-agent, and the row that opened it. */
export type ViewStep = { agent: string; row: string };

/** How a sub-agent's last run ended, when it did not simply finish or fail. */
export type Ending =
  | { kind: "stopped"; by: SubAgent["stopped_by"]; reason: string | null }
  | { kind: "lost"; resumable: boolean };

/** Everything a sub-agent's read-only view shows, from the Chat's records and items. */
export type SubAgentViewData = {
  agent: SubAgent;
  /** The sub-agents above it, outermost first: the crumbs between the Chat and it. */
  ancestors: SubAgent[];
  /** The Chat as its transcript reads it, with this sub-agent's own state. */
  chat: ChatState;
  /** The sub-agent's own items, in order. */
  items: TranscriptItem[];
  parts: TranscriptPart[];
  brief: { source: string; text: string | null; reported: boolean };
  ending: Ending | null;
  /** ticketd's note on what the harness does not report. */
  limits: boolean;
};

/** The sub-agents whose view is open, in order, dropping any the Chat no longer knows. */
export function viewPath(
  chat: Pick<ChatState, "sub_agents">,
  steps: readonly ViewStep[],
) {
  const known = (step: ViewStep) =>
    chat.sub_agents.some((agent) => agent.id === step.agent);
  const end = steps.findIndex((step) => !known(step));
  return end < 0 ? [...steps] : steps.slice(0, end);
}

/** The sub-agent's own items split by run, oldest first, in the order each run began. */
function runsOf(items: TranscriptItem[]) {
  const runs = new Map<string, TranscriptItem[]>();
  for (const item of items) {
    const key = item.turn_id ?? "";
    const run = runs.get(key);
    if (run) run.push(item);
    else runs.set(key, [item]);
  }
  return [...runs.values()];
}

/** Builds a sub-agent's view: its brief, its runs as turns, and how it ended. */
export function subAgentView(
  chat: ChatState,
  items: TranscriptItem[],
  id: string,
  now = Date.now(),
): SubAgentViewData | undefined {
  const agent = chat.sub_agents.find((one) => one.id === id);
  if (!agent) return undefined;
  const ancestors: SubAgent[] = [];
  for (
    let parent = agent.parent
      ? chat.sub_agents.find((one) => one.id === agent.parent)
      : undefined;
    parent && ancestors.length < 16;
    parent = parent.parent
      ? chat.sub_agents.find((one) => one.id === parent?.parent)
      : undefined
  )
    ancestors.unshift(parent);
  const own = items.filter((item) => item.owner === id);
  const running = agent.status === "running";
  const started = own.some((item) => item.kind !== "turn");
  const viewChat: ChatState = {
    ...chat,
    activity: running ? "working" : "idle",
    opening: null,
    stopping: false,
    problem: null,
    has_composer: false,
    queue: [],
    context: null,
    // Nothing of its work has come yet: it is starting.
    doing: running && !started ? { label: "Starting…", since: "" } : null,
  };
  const words = agent.capabilities.end
    ? SUB_AGENT_WORDS
    : SUB_AGENT_ENDS_WITH_TURN;
  const parts: TranscriptPart[] = [];
  runsOf(own).forEach((run, index) => {
    if (index > 0)
      parts.push({
        kind: "divider",
        key: `run:${run[0]?.id ?? index}`,
        label: "Resumed by the main agent",
      });
    parts.push(...turns(run, viewChat, now, words));
  });
  const parent = agent.parent
    ? chat.sub_agents.find((one) => one.id === agent.parent)
    : undefined;
  const asked =
    agent.brief?.source === "sub_agent" || agent.parent
      ? `Asked by the sub-agent ${parent?.title ?? "that started it"}`
      : "Asked by the main agent";
  const text = agent.brief?.text?.trim() || null;
  const reported = agent.capabilities.brief;
  return {
    agent,
    ancestors,
    chat: viewChat,
    items: own,
    parts,
    brief: {
      source: [asked, agent.type, agent.model].filter(Boolean).join(" · "),
      text:
        text ??
        (reported
          ? null
          : `${chat.harness.name} doesn't report what a sub-agent was asked.`),
      reported: reported && text !== null,
    },
    ending:
      agent.status === "stopped"
        ? {
            kind: "stopped",
            by: agent.stopped_by,
            reason: agent.stop_reason ?? null,
          }
        : agent.status === "lost"
          ? { kind: "lost", resumable: agent.capabilities.resume }
          : null,
    limits: !agent.capabilities.text && !agent.capabilities.end,
  };
}
