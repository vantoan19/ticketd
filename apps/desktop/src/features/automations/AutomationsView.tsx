import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Plus, SquarePen, Tag, Workflow, Zap } from "lucide-react";
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
import { AutomationEditor } from "@/features/automations/AutomationEditor";
import {
  automationsClient,
  HARNESS_NAMES,
  type Automation,
  type AutomationAgent,
  type AutomationAgentSettings,
  type AutomationDefinition,
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

/** What starts an Automation, as its list row says it. */
function startedBy(trigger: Automation["trigger"]) {
  if (!trigger) return <span>no trigger yet</span>;
  if (trigger.kind === "tag_added")
    return (
      <span className="auto-row-start">
        <Tag size={12} aria-hidden />
        {trigger.tag.trim() || "no tag yet"}
      </span>
    );
  return (
    <span className="auto-row-start">
      <Zap size={12} aria-hidden />
      {trigger.kind === "by_hand" ? "By hand" : "Another trigger"}
    </span>
  );
}

/**
 * The Automations screen, in the Chats list-and-detail split. The list header
 * switches between Automations and Agents; either opens beside the list and is
 * edited in place.
 */
export function AutomationsView() {
  const [tab, setTab] = useState<Tab>("automations");
  /** null until the first load answers. */
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [agents, setAgents] = useState<AutomationAgent[] | null>(null);
  /** What is open in each list; the other tab keeps its own. */
  const [openIds, setOpenIds] = useState<Record<Tab, string | null>>({
    automations: null,
    agents: null,
  });
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  /** Counts saves, so only the answer to the latest one is taken. */
  const saves = useRef(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowPane(workspaceRef, STACK_MIN_WIDTH);
  const single = narrow || expanded;

  const fail = useCallback((reason: unknown) => setError(String(reason)), []);
  const load = useCallback(
    () =>
      Promise.all([
        automationsClient.automations(),
        automationsClient.agents(),
      ]).then(([foundAutomations, foundAgents]) => {
        setAutomations(foundAutomations);
        setAgents(foundAgents);
        setError("");
      }, fail),
    [fail],
  );
  useEffect(() => void load(), [load]);
  useOnWorkspaceChange(() => void load());

  const openId = openIds[tab];
  const setOpenId = (id: string | null) =>
    setOpenIds((current) => ({ ...current, [tab]: id }));
  const openAgent =
    tab === "agents" ? agents?.find((a) => a.id === openId) : undefined;
  const openAutomation =
    tab === "automations"
      ? automations?.find((a) => a.id === openId)
      : undefined;
  const close = () => {
    setExpanded(false);
    setOpenId(null);
  };
  const paneProps = {
    expanded,
    single,
    onExpand: () => setExpanded(true),
    onReturn: () => {
      // Expanded returns to the split; a narrow window returns to the list.
      if (expanded) setExpanded(false);
      else close();
    },
    onClose: close,
  };

  const addAgent = () =>
    automationsClient.createAgent().then((agent) => {
      setAgents((current) => [agent, ...(current ?? [])]);
      return agent;
    });
  const createAgent = () =>
    addAgent().then((agent) => {
      setTab("agents");
      setOpenIds((current) => ({ ...current, agents: agent.id }));
    }, fail);
  const saveAgent = (id: string, settings: AutomationAgentSettings) => {
    setAgents(
      (current) =>
        current?.map((agent) =>
          agent.id === id ? { ...agent, ...settings } : agent,
        ) ?? null,
    );
    automationsClient.updateAgent(id, settings).then(() => setError(""), fail);
  };
  const deleteAgent = (id: string) =>
    automationsClient.deleteAgent(id).then(() => {
      setAgents((current) => current?.filter((a) => a.id !== id) ?? null);
      if (openIds.agents === id)
        setOpenIds((current) => ({ ...current, agents: null }));
    }, fail);

  const putAutomation = (saved: Automation) =>
    setAutomations(
      (current) =>
        current?.map((item) => (item.id === saved.id ? saved : item)) ?? null,
    );
  const createAutomation = () =>
    automationsClient.createAutomation().then((automation) => {
      setAutomations((current) => [automation, ...(current ?? [])]);
      setTab("automations");
      setOpenIds((current) => ({ ...current, automations: automation.id }));
    }, fail);
  const saveAutomation = (id: string, definition: AutomationDefinition) => {
    const save = ++saves.current;
    setAutomations(
      (current) =>
        current?.map((item) =>
          item.id === id ? { ...item, ...definition } : item,
        ) ?? null,
    );
    automationsClient.updateAutomation(id, definition).then((saved) => {
      // An earlier save's answer would undo what was typed since.
      if (save === saves.current) putAutomation(saved);
      setError("");
    }, fail);
  };
  const setEnabled = (id: string, enabled: boolean) =>
    automationsClient.setAutomationEnabled(id, enabled).then((saved) => {
      putAutomation(saved);
      setError("");
    }, fail);
  const deleteAutomation = (id: string) =>
    automationsClient.deleteAutomation(id).then(() => {
      setAutomations((current) => current?.filter((a) => a.id !== id) ?? null);
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
          tab === "agents" ? (
            <IconButton label="New agent" onClick={() => void createAgent()}>
              <SquarePen aria-hidden />
            </IconButton>
          ) : (
            <IconButton
              label="New Automation"
              onClick={() => void createAutomation()}
            >
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
            {
              value: "automations",
              label: "Automations",
              ...(automations && { count: automations.length }),
            },
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
        <>
          {automations?.length === 0 && (
            <p className="chat-list-empty">No Automations yet.</p>
          )}
          <ul className="chat-rows" aria-label="Automations">
            {automations?.map((automation) => (
              <li key={automation.id}>
                <button
                  type="button"
                  className="chat-row"
                  data-off={!automation.enabled || undefined}
                  aria-current={automation.id === openId ? "true" : undefined}
                  onClick={() => setOpenId(automation.id)}
                >
                  <span className="chat-row-mark">
                    <Workflow size={14} aria-hidden />
                  </span>
                  <span className="chat-row-title">
                    {automation.name.trim() || "New Automation"}
                  </span>
                  <span className="chat-row-time" />
                  <span className="chat-row-sub">
                    <span>
                      {automation.arrived_off
                        ? "Off on this desktop"
                        : automation.enabled
                          ? "On"
                          : "Off"}
                    </span>
                    {startedBy(automation.trigger)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
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
  const detailPane = openAgent ? (
    <AgentForm
      key={openAgent.id}
      agent={openAgent}
      {...paneProps}
      onSave={(settings) => saveAgent(openAgent.id, settings)}
      onDelete={() => void deleteAgent(openAgent.id)}
    />
  ) : openAutomation ? (
    <AutomationEditor
      key={openAutomation.id}
      automation={openAutomation}
      agents={agents ?? []}
      {...paneProps}
      onChange={(definition) => saveAutomation(openAutomation.id, definition)}
      onSetEnabled={(enabled) => void setEnabled(openAutomation.id, enabled)}
      onDelete={() => void deleteAutomation(openAutomation.id)}
      onCreateAgent={() =>
        addAgent().catch((reason: unknown) => {
          fail(reason);
          return undefined;
        })
      }
      onSaveAgent={saveAgent}
      onDeleteAgent={(id) => void deleteAgent(id)}
      onFail={fail}
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
      ) : automations?.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="Automations run steps when something happens to a ticket"
          description="Choose what starts it, then add a step that runs one of your agents."
          action={
            <Button size="sm" onClick={() => void createAutomation()}>
              <Plus aria-hidden />
              New Automation
            </Button>
          }
        />
      ) : (
        <p className="chat-list-empty">
          Open an Automation, or make a new one.
        </p>
      )}
    </section>
  );
  const open = openAgent ?? openAutomation;
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
