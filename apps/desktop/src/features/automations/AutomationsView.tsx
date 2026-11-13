import { use, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  FlaskConical,
  History,
  Plus,
  SquarePen,
  Tag,
  Workflow,
  Zap,
} from "lucide-react";
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
  type AutomationExample,
  type ListedRun,
} from "@/features/automations/client";
import { AllRunsList } from "@/features/automations/RunsList";
import { RunNavigation } from "@/features/automations/navigation";
import { RunView } from "@/features/automations/RunView";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import { useOnWorkspaceChange } from "@/lib/workspace-change";
import "@/features/chats/chats.css";
import "@/features/automations/automations.css";

type Tab = "automations" | "agents" | "runs";
const TAB_NAMES = {
  automations: { title: "Automations", list: "Automation list" },
  agents: { title: "Agents", list: "Agent list" },
  runs: { title: "Runs", list: "Run list" },
} as const;

/** What the empty page offers to start from. The core holds what each creates. */
const EXAMPLES = [
  {
    example: "triage_tagged_tickets",
    icon: Tag,
    title: "Triage tagged tickets",
    sub: "When a ticket is tagged, an agent triages it.",
  },
  {
    example: "verify_ready_for_testing",
    icon: FlaskConical,
    title: "Verify what is ready for testing",
    sub: "An agent checks the work, then the ticket moves on.",
  },
  {
    example: "weekly_summary",
    icon: CalendarClock,
    title: "Weekly summary",
    sub: "Every Monday, an agent writes up the week.",
  },
] as const satisfies { example: AutomationExample; [key: string]: unknown }[];

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
  if (trigger.kind === "tag_added" || trigger.kind === "tag_removed") {
    const tag = trigger.tag.trim();
    return (
      <span className="auto-row-start">
        <Tag size={12} aria-hidden />
        {!tag
          ? "no tag yet"
          : trigger.kind === "tag_added"
            ? tag
            : `${tag} removed`}
      </span>
    );
  }
  return (
    <span className="auto-row-start">
      <Zap size={12} aria-hidden />
      {trigger.kind === "status_changed"
        ? (trigger.to ?? "no status yet")
        : ROW_TRIGGERS[trigger.kind]}
    </span>
  );
}
const ROW_TRIGGERS = {
  ticket_created: "Ticket created",
  ticket_updated: "Ticket updated",
  activity_created: "Update added",
  schedule: "On a schedule",
  by_hand: "By hand",
} as const;

/**
 * The Automations screen, in the Chats list-and-detail split. The list header
 * switches between Automations, Agents and Runs. An Automation or an agent
 * opens beside the list and is edited in place; a run opens on its own view.
 */
export function AutomationsView({
  openRun,
}: {
  /** A run to open, asked for elsewhere; a new `key` asks again. */
  openRun?: { id: string; key: number } | null;
}) {
  const [tab, setTab] = useState<Tab>("automations");
  /** The run open in place of its Automation. */
  const [run, setRun] = useState<string | null>(null);
  /** null until the first load answers. */
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [agents, setAgents] = useState<AutomationAgent[] | null>(null);
  /** Every run, newest first. Loaded on any tab: the Runs tab marks one that needs the person. */
  const [runs, setRuns] = useState<ListedRun[] | null>(null);
  /** What is open in each list; the other tab keeps its own. */
  const [openIds, setOpenIds] = useState<Record<Tab, string | null>>({
    automations: null,
    agents: null,
    runs: null,
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
        automationsClient.allRuns(),
      ]).then(([foundAutomations, foundAgents, foundRuns]) => {
        setAutomations(foundAutomations);
        setAgents(foundAgents);
        setRuns(foundRuns);
        setError("");
      }, fail),
    [fail],
  );
  useEffect(() => void load(), [load]);
  useOnWorkspaceChange(() => void load());
  const asked = openRun?.id;
  const askedKey = openRun?.key;
  useEffect(() => {
    if (!asked) return;
    void automationsClient.run(asked).then((found) => {
      // Asked for from the list of every run, it opens beside that list;
      // from anywhere else, inside its Automation.
      setTab((current) => (current === "runs" ? "runs" : "automations"));
      setExpanded(false);
      setOpenIds((current) => ({
        ...current,
        automations: found.automation_id,
        runs: found.id,
      }));
      setRun(found.id);
    }, fail);
  }, [asked, askedKey, fail]);

  const openId = openIds[tab];
  const setOpenId = (id: string | null) => {
    setRun(null);
    setOpenIds((current) => ({ ...current, [tab]: id }));
  };
  const openAgent =
    tab === "agents" ? agents?.find((a) => a.id === openId) : undefined;
  const openAutomation =
    tab === "automations"
      ? automations?.find((a) => a.id === openId)
      : undefined;
  const listedRun = tab === "runs" ? openId : null;
  /** The page's run navigation; without it (the view alone) the run opens here. */
  const navigate = use(RunNavigation);
  const openListedRun = (id: string) => (navigate ?? setOpenId)(id);
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
  /** Lists a new Automation first and opens it. */
  const added = (created: Promise<Automation>) =>
    created.then((automation) => {
      setAutomations((current) => [automation, ...(current ?? [])]);
      setTab("automations");
      setOpenIds((current) => ({ ...current, automations: automation.id }));
    }, fail);
  const createAutomation = () => added(automationsClient.createAutomation());
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
  const stopAndTurnOff = (id: string) =>
    automationsClient.stopAndTurnOff(id).then((saved) => {
      putAutomation(saved);
      setError("");
    }, fail);
  const deleteAutomation = (id: string) =>
    automationsClient.deleteAutomation(id).then(() => {
      setAutomations((current) => current?.filter((a) => a.id !== id) ?? null);
      close();
    }, fail);

  const listPane = (
    <section className="ticket-list chat-pane" aria-label={TAB_NAMES[tab].list}>
      <ListHeader
        hideTitle
        title={TAB_NAMES[tab].title}
        actions={
          tab === "agents" ? (
            <IconButton label="New agent" onClick={() => void createAgent()}>
              <SquarePen aria-hidden />
            </IconButton>
          ) : (
            tab === "automations" && (
              <IconButton
                label="New Automation"
                onClick={() => void createAutomation()}
              >
                <SquarePen aria-hidden />
              </IconButton>
            )
          )
        }
      >
        <SegmentedControl
          aria-label="Show"
          value={tab}
          onValueChange={(next) => {
            setTab(next);
            setRun(null);
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
            {
              value: "runs",
              label: "Runs",
              ...(runs?.some((run) => run.needs_you) && {
                attention: "a run needs you",
              }),
            },
          ]}
        />
      </ListHeader>
      {error && (
        <p className="chat-list-empty" role="alert">
          {error}
        </p>
      )}
      {tab === "runs" ? (
        runs && (
          <AllRunsList runs={runs} openId={listedRun} onOpen={openListedRun} />
        )
      ) : tab === "automations" ? (
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
      openRun={run}
      onOpenRun={setRun}
      onChange={(definition) => saveAutomation(openAutomation.id, definition)}
      onSetEnabled={(enabled) => void setEnabled(openAutomation.id, enabled)}
      onStopAndTurnOff={() => void stopAndTurnOff(openAutomation.id)}
      onDuplicate={() =>
        void added(automationsClient.duplicateAutomation(openAutomation.id))
      }
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
  ) : listedRun ? (
    <RunView
      key={listedRun}
      id={listedRun}
      automationName={
        runs?.find((run) => run.id === listedRun)?.automation_name.trim() ||
        "New Automation"
      }
      agents={agents ?? []}
      {...paneProps}
      onBack={close}
      onOpenRun={openListedRun}
      onFail={fail}
    />
  ) : (
    <section
      className="ticket-detail chat-pane"
      aria-label={
        tab === "agents"
          ? "No agent open"
          : tab === "runs"
            ? "No run open"
            : "No Automation open"
      }
    >
      {tab === "runs" ? (
        runs?.length === 0 ? (
          <EmptyState
            icon={<History />}
            title="No runs yet"
            description="Every run of every Automation on this desktop shows here."
          />
        ) : (
          <p className="chat-list-empty">Open a run to see its steps.</p>
        )
      ) : tab === "agents" ? (
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
        <div className="auto-empty auto-start">
          <EmptyState
            icon={<Workflow />}
            title="Let agents act on tickets for you"
            description="An Automation runs steps when a ticket changes: tag a ticket, and a triage agent picks it up."
            action={
              <Button size="sm" onClick={() => void createAutomation()}>
                <Plus aria-hidden />
                New Automation
              </Button>
            }
          />
          <div
            className="auto-starters"
            role="group"
            aria-label="Start from an example"
          >
            <p className="auto-starters-label">Or start from an example</p>
            {EXAMPLES.map(({ example, icon: Icon, title, sub }) => (
              <button
                key={example}
                type="button"
                className="auto-starter"
                onClick={() =>
                  void added(automationsClient.createExample(example))
                }
              >
                <Icon size={16} aria-hidden />
                <span className="auto-starter-title">{title}</span>
                <span className="auto-starter-sub">{sub}</span>
                <ArrowRight size={16} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="chat-list-empty">
          Open an Automation, or make a new one.
        </p>
      )}
    </section>
  );
  const open = openAgent ?? openAutomation ?? listedRun;
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
