import { useHarnessCatalog } from "@/features/chats/harness-catalog";
import {
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  ChevronDown,
  FlaskConical,
  History,
  Play,
  SquarePen,
  Tag,
  Workflow,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert, AlertActions, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { enter } from "@/components/ui/enter";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeader } from "@/components/ui/list-header";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { AgentForm } from "@/features/automations/AgentForm";
import { AutomationEditor } from "@/features/automations/AutomationEditor";
import {
  automationsClient,
  type ReportRead,
  type Automation,
  type AutomationAgent,
  type AutomationAgentSettings,
  type AutomationDefinition,
  type AutomationExample,
  type ListedRun,
} from "@/features/automations/client";
import { scheduleText } from "@/features/automations/automation-text";
import { AllRunsList } from "@/features/automations/RunsList";
import { RunNavigation } from "@/features/automations/navigation";
import { RunView } from "@/features/automations/RunView";
import { runStatusText } from "@/features/automations/runs-model";
import { chatTime } from "@/features/chats/model";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import { useOnWorkspaceChange } from "@/lib/workspace-change";
import { emptyCopy } from "@/lib/empty-copy";
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
    sub: "Check ready work, then mark it Done or tag it needs-fix.",
  },
  {
    example: "weekly_summary",
    icon: CalendarClock,
    title: "Weekly summary",
    sub: "Every Monday, an agent writes up the week.",
  },
] as const satisfies { example: AutomationExample; [key: string]: unknown }[];

/** The list pane's 300px plus the detail pane's 480px, as in Chats. */
const STACK_MIN_WIDTH = 780;
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
  if (trigger.kind === "schedule")
    return (
      <span className="auto-row-start">
        <CalendarClock size={12} aria-hidden />
        {scheduleText(trigger.schedule)}
      </span>
    );
  if (trigger.kind === "by_hand")
    return (
      <span className="auto-row-start">
        <Play size={12} aria-hidden />
        By hand
      </span>
    );
  if (trigger.kind === "status_changed" && trigger.to)
    return (
      <span className="auto-row-start">
        <StatusIcon status={trigger.to} size={12} decorative />
        Status → {trigger.to}
      </span>
    );
  return (
    <span className="auto-row-start">
      <Zap size={12} aria-hidden />
      {trigger.kind === "status_changed"
        ? "no status yet"
        : ROW_TRIGGERS[trigger.kind]}
    </span>
  );
}
const ROW_TRIGGERS = {
  ticket_created: "Ticket created",
  ticket_updated: "Ticket updated",
  activity_created: "Update posted",
} as const;

/**
 * The Automations screen, in the Chats list-and-detail split. The list header
 * switches between Automations, Agents and Runs. An Automation or an agent
 * opens beside the list and is edited in place; a run opens on its own view.
 */
export function AutomationsView({
  openRun,
  onRunOpened,
}: {
  /** A run to open, asked for elsewhere; a new `key` asks again. */
  openRun?: { id: string; key: number } | null;
  /**
   * The run asked for was opened, or could not be: the asker forgets it, so
   * coming back to this page later shows the list, not that run again.
   */
  onRunOpened?: () => void;
}) {
  const harnessCatalog = useHarnessCatalog();
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
  /** Why the lists could not be read; a read that works clears it. */
  const [error, setError] = useState("");
  /**
   * What the person last asked for and did not get (a switch, a delete, a run).
   * It shows above whichever pane is on screen and stays until they dismiss it
   * or the same thing works: a refresh of the lists does not take it away.
   */
  const [failure, setFailure] = useState<{
    action: string;
    text: string;
  } | null>(null);
  /** Counts saves, so only the answer to the latest one is taken. */
  const saves = useRef(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowPane(workspaceRef, STACK_MIN_WIDTH);
  const single = narrow || expanded;

  const failed = useCallback(
    (action: string, what: string) => (reason: unknown) =>
      setFailure({
        action,
        text: `${what} ${reason instanceof Error ? reason.message : String(reason)}`,
      }),
    [],
  );
  /** `action` worked, so what it failed with before no longer stands. */
  const worked = useCallback(
    (action: string) =>
      setFailure((current) => (current?.action === action ? null : current)),
    [],
  );
  /** For what the open pane does when asked: a new run, choosing a folder. */
  const fail = useCallback(
    (reason: unknown) => failed("pane", "That did not work.")(reason),
    [failed],
  );
  /**
   * For what the open pane reads by itself: a run, an Automation's runs, the
   * projects. Those reads repeat whenever the Workspace changes, so one that
   * failed says so only until the same read works.
   */
  const read = useCallback<ReportRead>(
    (what, failure) => {
      if (failure) failed(`read ${what}`, "That did not work.")(failure.reason);
      else worked(`read ${what}`);
    },
    [failed, worked],
  );
  const load = useCallback(() => {
    const saved = saves.current;
    return Promise.all([
      automationsClient.automations(),
      automationsClient.agents(),
      automationsClient.allRuns(),
    ]).then(
      ([foundAutomations, foundAgents, foundRuns]) => {
        // Read before a save that has been made since: it would put the old
        // definition back under the editor. The save's own change reads again.
        if (saved === saves.current) {
          setAutomations(foundAutomations);
          setAgents(foundAgents);
        }
        setRuns(foundRuns);
        setError("");
      },
      (reason: unknown) => setError(String(reason)),
    );
  }, []);
  useEffect(() => void load(), [load]);
  useOnWorkspaceChange(() => void load());
  const asked = openRun?.id;
  const askedKey = openRun?.key;
  const opened = useEffectEvent(() => onRunOpened?.());
  useEffect(() => {
    if (!asked) return;
    void Promise.all([
      automationsClient.run(asked),
      automationsClient.automations(),
    ])
      .then(
        ([found, listed]) => {
          // Asked for from the list of every run, it opens beside that list;
          // from anywhere else, inside its Automation. A run whose Automation
          // was deleted has only the list of every run to open in.
          const kept = listed.some((item) => item.id === found.automation_id);
          setTab((current) =>
            current === "runs" || !kept ? "runs" : "automations",
          );
          setExpanded(false);
          setOpenIds((current) => ({
            ...current,
            ...(kept && { automations: found.automation_id }),
            runs: found.id,
          }));
          setRun(kept ? found.id : null);
        },
        failed("open-run", "That run could not be opened."),
      )
      .finally(opened);
  }, [asked, askedKey, failed]);

  const openId = openIds[tab];
  const setOpenId = (id: string | null) => {
    setRun(null);
    // What failed in the pane that was open is not about the next one.
    setFailure(null);
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
    addAgent().then(
      (agent) => {
        worked("new-agent");
        setTab("agents");
        setOpenIds((current) => ({ ...current, agents: agent.id }));
      },
      failed("new-agent", "The agent could not be made."),
    );
  /** Saves the agent and resolves to it as it is then stored. */
  const saveAgent = (id: string, settings: AutomationAgentSettings) => {
    const save = ++saves.current;
    const saved = automationsClient.updateAgent(id, settings);
    void saved.then(
      (agent) => {
        // An earlier save's answer would undo what was typed since, or clear
        // the failure of a later save answered before it.
        if (save !== saves.current) return;
        worked("save-agent");
        setAgents(
          (current) =>
            current?.map((item) => (item.id === id ? agent : item)) ?? null,
        );
      },
      failed(
        "save-agent",
        "Your last change to the agent was not saved; change it again to retry.",
      ),
    );
    return saved;
  };
  const deleteAgent = (id: string) =>
    automationsClient.deleteAgent(id).then(
      () => {
        worked("delete-agent");
        setAgents((current) => current?.filter((a) => a.id !== id) ?? null);
        if (openIds.agents === id)
          setOpenIds((current) => ({ ...current, agents: null }));
      },
      failed("delete-agent", "The agent could not be deleted."),
    );

  const putAutomation = (saved: Automation) =>
    setAutomations(
      (current) =>
        current?.map((item) => (item.id === saved.id ? saved : item)) ?? null,
    );
  /** Lists a new Automation first and opens it. */
  const added = (created: Promise<Automation>) =>
    created.then(
      (automation) => {
        worked("new-automation");
        setAutomations((current) => [automation, ...(current ?? [])]);
        setTab("automations");
        // As setOpenId does: the run and what failed belonged to the pane before.
        setRun(null);
        setFailure(null);
        setOpenIds((current) => ({ ...current, automations: automation.id }));
      },
      failed("new-automation", "The Automation could not be made."),
    );
  const createAutomation = () => added(automationsClient.createAutomation());
  /**
   * Saves an edit and resolves to the Automation as it is then stored. The
   * editor that made the edit keeps it and says so when the save fails.
   */
  const saveAutomation = (
    id: string,
    definition: AutomationDefinition,
    typing: boolean,
  ) => {
    const save = ++saves.current;
    const saved = automationsClient.updateAutomation(id, definition, typing);
    // An earlier save's answer would undo what was typed since.
    void saved.then(
      (automation) => save === saves.current && putAutomation(automation),
      () => undefined,
    );
    return saved;
  };
  const setEnabled = (id: string, enabled: boolean) =>
    automationsClient.setAutomationEnabled(id, enabled).then(
      (saved) => {
        putAutomation(saved);
        worked("switch");
      },
      failed(
        "switch",
        enabled
          ? "It could not be switched on."
          : "It could not be switched off.",
      ),
    );
  const stopAndTurnOff = (id: string) =>
    automationsClient.stopAndTurnOff(id).then(
      (saved) => {
        putAutomation(saved);
        worked("switch");
      },
      failed("switch", "It could not be stopped and switched off."),
    );
  const deleteAutomation = (id: string) =>
    automationsClient.deleteAutomation(id).then(
      () => {
        setAutomations(
          (current) => current?.filter((a) => a.id !== id) ?? null,
        );
        close();
      },
      failed("delete", "The Automation could not be deleted."),
    );

  const count = { automations, agents, runs }[tab]?.length;
  const empty = count === 0;
  const needsYou = runs?.some((run) => run.needs_you);
  const copy = emptyCopy(tab === "runs" ? "automation-runs" : tab);
  const emptyList = (
    <EmptyState
      icon={
        tab === "automations" ? (
          <Workflow />
        ) : tab === "agents" ? (
          <Bot />
        ) : (
          <History />
        )
      }
      title={copy.title}
      description={copy.sentence}
    />
  );
  const examples = (
    <div
      className="auto-starters"
      role="group"
      aria-label="Start from an example"
    >
      <div {...enter(2)}>
        <p className="auto-starters-label">Start from an example</p>
      </div>
      {EXAMPLES.map(({ example, icon: Icon, title, sub }, index) => (
        <div key={example} {...enter(index + 3)}>
          <button
            type="button"
            className="auto-starter"
            onClick={() => void added(automationsClient.createExample(example))}
          >
            <Icon size={16} aria-hidden />
            <span className="auto-starter-title">{title}</span>
            <span className="auto-starter-sub">{sub}</span>
            <ArrowRight size={16} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
  const listPane = (
    <section
      className="ticket-list chat-pane auto-list-pane"
      data-empty={empty || undefined}
      aria-label={TAB_NAMES[tab].list}
    >
      <div className="auto-list-head" {...enter(0)}>
        <PaneHeader
          title={TAB_NAMES[tab].title}
          titleControl={(title) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <span className="truncate">{title}</span>
                  <ChevronDown aria-hidden />
                  {needsYou && (
                    <>
                      <StatusDot tone="attention" size={6} />
                      <span className="sr-only">, a run needs you</span>
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={tab}
                  onValueChange={(next) => {
                    setTab(next as Tab);
                    setRun(null);
                    setExpanded(false);
                  }}
                >
                  {Object.entries(TAB_NAMES).map(([value, { title }]) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {title}
                      {value === "runs" && needsYou && (
                        <>
                          <StatusDot tone="attention" size={6} />
                          <span className="sr-only">, a run needs you</span>
                        </>
                      )}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          count={
            count !== undefined && (
              <>
                <Count>{count}</Count>
                <span className="sr-only">
                  {" "}
                  {TAB_NAMES[tab].title.toLowerCase()}
                </span>
              </>
            )
          }
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
        />
      </div>
      {error && (
        <p className="chat-list-empty" role="alert">
          {error}
        </p>
      )}
      {empty &&
        (tab === "automations" && narrow ? (
          <div className="auto-empty auto-start">
            <div {...enter(1)}>{emptyList}</div>
            {examples}
          </div>
        ) : (
          <div {...enter(1)}>{emptyList}</div>
        ))}
      {tab === "runs" ? (
        !empty &&
        runs && (
          <AllRunsList runs={runs} openId={listedRun} onOpen={openListedRun} />
        )
      ) : tab === "automations" ? (
        <>
          <ul
            className="chat-rows"
            aria-label="Automations"
            {...(!empty && enter(1))}
          >
            {automations?.map((automation) => {
              // Runs arrive newest first: the first of its runs is the latest.
              const latest = runs?.find(
                (item) => item.automation_id === automation.id,
              );
              const byHand = automation.trigger?.kind === "by_hand";
              // Off says so; one that can run says how its latest run stands.
              const state = automation.arrived_off
                ? "Off on this desktop"
                : !automation.enabled && !byHand
                  ? "Off"
                  : latest
                    ? runStatusText(latest)
                    : byHand
                      ? null
                      : "On";
              return (
                <li key={automation.id}>
                  <button
                    type="button"
                    className="chat-row"
                    // One that is run by hand is neither on nor off.
                    data-off={
                      (!automation.enabled &&
                        automation.trigger?.kind !== "by_hand") ||
                      undefined
                    }
                    aria-current={automation.id === openId ? "true" : undefined}
                    onClick={() => setOpenId(automation.id)}
                  >
                    <span className="chat-row-mark">
                      <Workflow size={14} aria-hidden />
                    </span>
                    <Tooltip
                      overflowOnly
                      content={automation.name.trim() || "New Automation"}
                    >
                      <span className="chat-row-title">
                        {automation.name.trim() || "New Automation"}
                      </span>
                    </Tooltip>
                    <span className="chat-row-time">
                      {latest && chatTime(latest.created_at)}
                    </span>
                    <span className="chat-row-sub">
                      {state && <span>{state}</span>}
                      {startedBy(automation.trigger)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <ul
            className="chat-rows"
            aria-label="Agents"
            {...(!empty && enter(1))}
          >
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
                  <Tooltip
                    overflowOnly
                    content={agent.name.trim() || "New agent"}
                  >
                    <span className="chat-row-title">
                      {agent.name.trim() || "New agent"}
                    </span>
                  </Tooltip>
                  <span className="chat-row-time" />
                  <span className="chat-row-sub">
                    <span>
                      {harnessCatalog.find(
                        (entry) => entry.id === agent.harness,
                      )?.name ?? agent.harness}
                    </span>
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
      needsYou={
        runs?.some(
          (item) => item.automation_id === openAutomation.id && item.needs_you,
        ) ?? false
      }
      openRun={run}
      onOpenRun={setRun}
      onChange={(definition, typing) =>
        saveAutomation(openAutomation.id, definition, typing)
      }
      onSetEnabled={(enabled) => void setEnabled(openAutomation.id, enabled)}
      onStopAndTurnOff={() => void stopAndTurnOff(openAutomation.id)}
      onDuplicate={() =>
        void added(automationsClient.duplicateAutomation(openAutomation.id))
      }
      onDelete={() => void deleteAutomation(openAutomation.id)}
      onCreateAgent={() =>
        addAgent().catch((reason: unknown) => {
          failed("new-agent", "The agent could not be made.")(reason);
          return undefined;
        })
      }
      onSaveAgent={saveAgent}
      onDeleteAgent={(id) => void deleteAgent(id)}
      onFail={fail}
      onRead={read}
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
      onRead={read}
    />
  ) : (
    <section
      className="ticket-detail chat-pane auto-detail-pane"
      aria-label={
        tab === "agents"
          ? "No agent open"
          : tab === "runs"
            ? "No run open"
            : "No Automation open"
      }
    >
      {empty && tab === "automations" ? (
        <div className="auto-empty auto-start">
          <div {...enter(1)}>
            <EmptyState
              icon={<Workflow />}
              title="Let agents act on tickets for you"
              description="Run a sequence of steps when a ticket changes, on a schedule, or whenever you choose."
            />
          </div>
          {!narrow && examples}
        </div>
      ) : (
        <EmptyState
          size="hint"
          title={
            tab === "runs"
              ? "Open a run to see its steps."
              : tab === "agents"
                ? "Open an agent, or make a new one."
                : "Open an Automation, or make a new one."
          }
        />
      )}
    </section>
  );
  const open = openAgent ?? openAutomation ?? listedRun;
  return (
    <div ref={workspaceRef} className="plan-workspace" data-own-entrance="">
      {failure && (
        <div className="auto-failure">
          <Alert size="compact" tone="error">
            <AlertDescription>{failure.text}</AlertDescription>
            <AlertActions>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFailure(null)}
              >
                Dismiss
              </Button>
            </AlertActions>
          </Alert>
        </div>
      )}
      <div
        className="ticket-workspace chats-workspace"
        data-single={single ? (open ? "detail" : "list") : undefined}
      >
        <ResizablePanelGroup orientation="horizontal" disabled={single}>
          <ResizablePanel
            id="chat-list"
            minSize={300}
            defaultSize={300}
            aria-hidden={single && !!open ? true : undefined}
          >
            {listPane}
          </ResizablePanel>
          <ResizableHandle
            aria-label="Resize list"
            aria-hidden={single || undefined}
          />
          <ResizablePanel
            id="chat-detail"
            minSize={480}
            style={PANEL_STYLE}
            aria-hidden={single && !open ? true : undefined}
          >
            {detailPane}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
