import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
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
    <span aria-hidden="true" className="text-muted-foreground">
      {" "}
      · {useElapsed(started)}
    </span>
  );
}

/** What an agent's line says after its name: a sub-agent's title, a main agent's current step. */
const lineOf = (agent: TicketAgent) =>
  agent.sub_agent ? agent.title : (agent.doing ?? null);

/**
 * The ticket's label of who is working on it (DESIGN §7), from the host's list
 * of agents. One agent is named with what it is doing and its clock, two are
 * named, and from three the first is named and the rest are "N others" in a
 * menu. Each name opens that agent: a main agent's Chat, or a sub-agent's view
 * inside its Chat. A request waiting for the person replaces the label.
 */
export function TicketAgentsLabel({
  agents,
  reference,
}: {
  agents: TicketAgent[];
  reference: string;
}) {
  const { requestChat } = useChatFeature();
  const open = (agent: TicketAgent, view: boolean) =>
    requestChat({
      kind: "open",
      chatId: agent.chat_id,
      retention: agent.retention,
      from: reference,
      ...(view && agent.sub_agent && { subAgent: agent.sub_agent }),
    });
  const asking = agents.find((agent) => agent.approval);
  const first = asking ?? agents[0];
  if (!first) return null;
  return (
    <>
      <div
        className="ticket-agent-copy ui-agent-state"
        key={asking ? "approval" : "working"}
      >
        {asking?.approval ? (
          <>
            <StatusDot tone="attention" size={6} />
            <span>
              <AgentName agent={asking} onOpen={() => open(asking, true)} />{" "}
              wants to run{" "}
              <code className="chat-mono">{asking.approval.summary}</code>
            </span>
          </>
        ) : (
          <>
            <HarnessMark
              harness={first.harness_id}
              name={first.harness_name}
              decorative
            />
            <span>
              <WorkingLine agents={agents} open={open} />
              {agents.length === 1 && <Detail agent={first} />}
            </span>
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          </>
        )}
      </div>
      <Tooltip
        content={
          asking ? "Review the request in Chat" : "Open this ticket’s Chat"
        }
      >
        <Button
          variant={asking ? "outline" : "ghost"}
          size="compact"
          onClick={() => open(asking ?? first, Boolean(asking))}
        >
          {asking ? "Review request" : "Open Chat"}
        </Button>
      </Tooltip>
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

function Detail({ agent }: { agent: TicketAgent }) {
  const line = lineOf(agent);
  return (
    <>
      {line && <span className="text-muted-foreground"> · {line}</span>}
      <Elapsed started={agent.started_at} />
    </>
  );
}

function WorkingLine({
  agents,
  open,
}: {
  agents: TicketAgent[];
  open: (agent: TicketAgent, view: boolean) => void;
}) {
  const [first, second, ...rest] = agents;
  if (!first) return null;
  const name = (agent: TicketAgent) => (
    <AgentName agent={agent} onOpen={() => open(agent, true)} />
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
          className="w-80 p-2"
          aria-label="Agents working on this ticket"
        >
          {many.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              className="ticket-agents-item"
              onSelect={() => open(agent, true)}
            >
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
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>{" "}
      are working on this ticket
    </>
  );
}

function Clock({ started }: { started: string }) {
  return useElapsed(started);
}
