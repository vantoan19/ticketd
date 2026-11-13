import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Plus, SquarePen, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ListHeader } from "@/components/ui/list-header";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AgentForm } from "@/features/automations/AgentForm";
import {
  automationsClient,
  type AutomationAgent,
  type AutomationAgentSettings,
} from "@/features/automations/client";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import { useOnWorkspaceChange } from "@/lib/workspace-change";
import "@/features/chats/chats.css";
import "@/features/automations/automations.css";

type Tab = "automations" | "agents";

/** The list pane's 360px plus the detail pane's 480px: below this one pane shows. */
const STACK_MIN_WIDTH = 840;
const PANEL_STYLE = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
} as const;
const HARNESS_NAMES = { "claude-code": "Claude Code", codex: "Codex" } as const;

/**
 * The Automations screen, in the Chats list-and-detail split. The list header
 * switches between Automations and Agents; an agent opens beside the list and
 * is edited in place.
 */
export function AutomationsView() {
  const [tab, setTab] = useState<Tab>("automations");
  /** null until the first load answers. */
  const [agents, setAgents] = useState<AutomationAgent[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowPane(workspaceRef, STACK_MIN_WIDTH);
  const single = narrow || expanded;

  const fail = (reason: unknown) => setError(String(reason));
  const load = useCallback(
    () =>
      automationsClient.agents().then((found) => {
        setAgents(found);
        setError("");
      }, fail),
    [],
  );
  useEffect(() => void load(), [load]);
  useOnWorkspaceChange(() => void load());

  const open = tab === "agents" ? agents?.find((a) => a.id === openId) : null;
  const close = () => {
    setExpanded(false);
    setOpenId(null);
  };
  const createAgent = () =>
    automationsClient.createAgent().then((agent) => {
      setAgents((current) => [agent, ...(current ?? [])]);
      setTab("agents");
      setOpenId(agent.id);
    }, fail);
  const saveAgent = (id: string, settings: AutomationAgentSettings) => {
    setAgents(
      (current) =>
        current?.map((agent) =>
          agent.id === id ? { id, ...settings } : agent,
        ) ?? null,
    );
    automationsClient.updateAgent(id, settings).then(() => setError(""), fail);
  };
  const deleteAgent = (id: string) =>
    automationsClient.deleteAgent(id).then(() => {
      setAgents((current) => current?.filter((a) => a.id !== id) ?? null);
      close();
    }, fail);

  const listPane = (
    <section
      className="ticket-list chat-pane"
      aria-label={tab === "agents" ? "Agent list" : "Automation list"}
    >
      <ListHeader
        hideTitle
        title={tab === "agents" ? "Agents" : "Automations"}
        actions={
          tab === "agents" && (
            <IconButton label="New agent" onClick={() => void createAgent()}>
              <SquarePen aria-hidden />
            </IconButton>
          )
        }
      >
        <SegmentedControl
          aria-label="Show"
          value={tab}
          onValueChange={(next) => {
            setTab(next);
            setExpanded(false);
          }}
          options={[
            { value: "automations", label: "Automations" },
            {
              value: "agents",
              label: "Agents",
              ...(agents && { count: agents.length }),
            },
          ]}
        />
      </ListHeader>
      {error && (
        <p className="chat-list-empty" role="alert">
          {error}
        </p>
      )}
      {tab === "automations" ? (
        <p className="chat-list-empty">No Automations yet.</p>
      ) : (
        <>
          {agents?.length === 0 && (
            <p className="chat-list-empty">No agents yet.</p>
          )}
          <ul className="chat-rows" aria-label="Agents">
            {agents?.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className="chat-row"
                  aria-current={agent.id === openId ? "true" : undefined}
                  onClick={() => setOpenId(agent.id)}
                >
                  <span className="chat-row-mark">
                    <Bot size={14} aria-hidden />
                  </span>
                  <span className="chat-row-title">
                    {agent.name.trim() || "New agent"}
                  </span>
                  <span className="chat-row-time" />
                  <span className="chat-row-sub">
                    <span>{HARNESS_NAMES[agent.harness]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
  const detailPane = open ? (
    <AgentForm
      key={open.id}
      agent={open}
      expanded={expanded}
      single={single}
      onExpand={() => setExpanded(true)}
      onReturn={() => {
        // Expanded returns to the split; a narrow window returns to the list.
        if (expanded) setExpanded(false);
        else close();
      }}
      onClose={close}
      onSave={(settings) => saveAgent(open.id, settings)}
      onDelete={() => void deleteAgent(open.id)}
    />
  ) : (
    <section
      className="ticket-detail chat-pane"
      aria-label={tab === "agents" ? "No agent open" : "No Automation open"}
    >
      {tab === "agents" ? (
        agents?.length === 0 ? (
          <EmptyState
            icon={<Bot />}
            title="An agent is who a step runs"
            description="A harness, instructions, and the tools it may use. Make one, then use it in any Automation."
            action={
              <Button size="sm" onClick={() => void createAgent()}>
                <Plus aria-hidden />
                New agent
              </Button>
            }
          />
        ) : (
          <p className="chat-list-empty">Open an agent, or make a new one.</p>
        )
      ) : (
        <EmptyState
          icon={<Workflow />}
          title="Automations run steps when something happens to a ticket"
          description="Start with an agent: it is who a step runs."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setTab("agents")}
            >
              Show Agents
            </Button>
          }
        />
      )}
    </section>
  );
  return (
    <div ref={workspaceRef} className="plan-workspace">
      {single ? (
        <div className="ticket-workspace chats-workspace">
          {open ? detailPane : listPane}
        </div>
      ) : (
        <div className="ticket-workspace chats-workspace">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="chat-list" minSize={360} defaultSize={384}>
              {listPane}
            </ResizablePanel>
            <ResizableHandle aria-label="Resize list" />
            <ResizablePanel id="chat-detail" minSize={480} style={PANEL_STYLE}>
              {detailPane}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  );
}
