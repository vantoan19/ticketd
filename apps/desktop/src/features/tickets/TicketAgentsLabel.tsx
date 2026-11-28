import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { useChatFeature } from "@/features/chats/use-chats";
import { duration } from "@/features/chats/model";
import { agentName, type TicketAgent } from "@/features/chats/ticket-agents";
import { agentTarget, openAgentChat } from "./ticket-agent-state";

/** The clock of work that began at `started`, ticking each second. */
function useElapsed(started: string) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return duration(Math.max(0, now - Date.parse(started)));
}

/** "· 2m 10s", hidden from assistive technology. */
export function Elapsed({ started }: { started: string }) {
  return (
    <span
      aria-hidden="true"
      className="ticket-agent-clock text-muted-foreground"
    >
      {" "}
      · {useElapsed(started)}
    </span>
  );
}

/** What an agent's line says after its name: a sub-agent's title, a main agent's current step. */
const lineOf = (agent: TicketAgent) =>
  agent.sub_agent ? agent.title : (agent.doing ?? null);

/** The host's model wording and ordering, including linked sub-agents. */
export function TicketAgentsLabel({
  agents,
  reference,
}: {
  agents: TicketAgent[];
  reference: string;
}) {
  const { requestChat } = useChatFeature();
  const first = agents[0];
  if (!first) return null;
  const line = lineOf(first);
  return (
    <>
      <div className="ticket-decision-line ticket-decision-title">
        <HarnessMark
          harness={first.harness_id}
          name={first.harness_name}
          decorative
        />
        <span>
          <WorkingLine
            agents={agents}
            open={(agent) =>
              requestChat(openAgentChat(agentTarget(agent), reference, true))
            }
          />
        </span>
      </div>
      <p className="ticket-decision-byline">
        {line}
        <Elapsed started={first.started_at} />
      </p>
    </>
  );
}

function AgentName({
  agent,
  onOpen,
}: {
  agent: TicketAgent;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="ticket-agent-name"
      aria-label={
        agent.sub_agent
          ? `${agentName(agent)}, open sub-agent ${agent.title}`
          : `${agentName(agent)}, open its Chat`
      }
      onClick={onOpen}
    >
      {agentName(agent)}
    </button>
  );
}

function WorkingLine({
  agents,
  open,
}: {
  agents: TicketAgent[];
  open: (agent: TicketAgent) => void;
}) {
  const [first, second, ...rest] = agents;
  if (!first) return null;
  const name = (agent: TicketAgent) => (
    <AgentName agent={agent} onOpen={() => open(agent)} />
  );
  if (!second) return <>{name(first)} is working on this ticket</>;
  if (rest.length === 0)
    return (
      <>
        {name(first)} and {name(second)} are working on this ticket
      </>
    );
  const many = agents.slice(1);
  return (
    <>
      {name(first)} and{" "}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ticket-agent-others"
            aria-haspopup="menu"
          >
            {`${many.length} others`}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          alignOffset={-12}
          sideOffset={6}
          aria-label="Agents working on this ticket"
        >
          <div className="ticket-agents-menu">
            {many.map((agent) => (
              <DropdownMenuItem key={agent.id} onSelect={() => open(agent)}>
                <span className="ticket-agents-item">
                  <HarnessMark
                    harness={agent.harness_id}
                    name={agent.harness_name}
                    decorative
                  />
                  <span className="ticket-agents-who">{agentName(agent)}</span>
                  <span className="ticket-agents-time" aria-hidden="true">
                    <Clock started={agent.started_at} />
                  </span>
                  <span className="ticket-agents-what">
                    {agent.sub_agent
                      ? `${agent.title} · sub-agent in ${agent.chat_title}`
                      : agent.title}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>{" "}
      are working on this ticket
    </>
  );
}

function Clock({ started }: { started: string }) {
  return useElapsed(started);
}
