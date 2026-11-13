import { useCallback, useEffect, useId, useState } from "react";
import {
  ArrowLeft,
  Maximize2,
  MessageSquareText,
  Minimize2,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { TRIGGER_ID } from "@/features/automations/canvas-layout";
import {
  automationsClient,
  stepPaths,
  type AutomationAgent,
  type AutomationRunDetail,
} from "@/features/automations/client";
import {
  CARD_ICONS,
  runCard,
  triggerCard,
} from "@/features/automations/flow-cards";
import { RunCanvas, StepMark } from "@/features/automations/RunCanvas";
import { RunMark } from "@/features/automations/RunsList";
import {
  everyStep,
  RUN_STATUS_LABELS,
  STEP_STATE_LABELS,
  stepStates,
} from "@/features/automations/runs-model";
import { StepPanel } from "@/features/automations/StepPanel";
import { ChatDetail } from "@/features/chats/ChatDetail";
import { elapsed } from "@/features/chats/model";
import { useOnWorkspaceChange } from "@/lib/workspace-change";

const when = (timestamp: string) =>
  new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** What the panel says about the selected card: the step's outcome, then the run. */
function RunPanel({
  run,
  agents,
  selected,
  onOpenChat,
  onClose,
}: {
  run: AutomationRunDetail;
  agents: AutomationAgent[];
  selected: string;
  onOpenChat: (chatId: string) => void;
  onClose: () => void;
}) {
  const step = everyStep(run.definition.steps).find(
    (item) => item.id === selected,
  );
  const card =
    selected === TRIGGER_ID
      ? triggerCard(run.definition.trigger)
      : step && runCard(step, agents);
  if (!card) return null;
  const Icon = CARD_ICONS[card.icon];
  const reached = (id: string | undefined) =>
    run.steps.find((item) => item.step_id === id);
  const record = reached(selected);
  const state = stepStates(run).get(selected);
  const label = state && STEP_STATE_LABELS[state];
  const handled =
    record?.status === "failed" &&
    step &&
    reached(stepPaths(step).on_failure?.[0]?.id);
  return (
    <StepPanel
      key={selected}
      title={card.kind}
      icon={<Icon size={16} aria-hidden />}
      onClose={onClose}
    >
      {state && (
        <div className="flow-panel-section">
          <p className="flow-card-status">
            <StepMark state={state} />
            {state === "failed" ? <strong>{label}</strong> : label}
          </p>
          {record?.reason && <p className="run-reason">{record.reason}</p>}
          {handled && (
            <p className="flow-panel-note">
              The run went on down this step’s failure path.
            </p>
          )}
          {record?.chat_id && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => onOpenChat(record.chat_id ?? "")}
            >
              <MessageSquareText aria-hidden />
              Open Chat
            </Button>
          )}
        </div>
      )}
      <div className="flow-panel-section">
        <h4>This run</h4>
        <dl className="flow-panel-facts">
          <dt>Ticket</dt>
          <dd>
            {run.ticket ? (
              <>
                <span className="auto-ref">{run.ticket.reference}</span>{" "}
                {run.ticket.title}
              </>
            ) : (
              "No ticket"
            )}
          </dd>
          <dt>Started</dt>
          <dd>
            {run.started_at ? when(run.started_at) : "Not yet"}
            {run.definition.trigger?.kind === "tag_added" &&
              `, when ${run.definition.trigger.tag} was added`}
            {run.definition.trigger?.kind === "schedule" && ", on its schedule"}
            {run.definition.trigger?.kind === "by_hand" && ", by hand"}
          </dd>
          {run.started_at && run.ended_at && (
            <>
              <dt>Took</dt>
              <dd>
                {elapsed(
                  new Date(run.ended_at).getTime() -
                    new Date(run.started_at).getTime(),
                )}
              </dd>
            </>
          )}
        </dl>
      </div>
    </StepPanel>
  );
}

/**
 * One run on the read-only canvas. It follows the Workspace, so each step's
 * status changes as the run goes. A run in progress can be stopped; a finished
 * one can be run again, which makes a new run and opens it.
 */
export function RunView({
  id,
  automationName,
  agents,
  expanded,
  single,
  onExpand,
  onReturn,
  onClose,
  onBack,
  onOpenRun,
  onFail,
}: {
  id: string;
  automationName: string;
  agents: AutomationAgent[];
  expanded: boolean;
  single: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  /** Back to the Automation's runs. */
  onBack: () => void;
  onOpenRun: (id: string) => void;
  onFail: (reason: unknown) => void;
}) {
  const headingId = useId();
  const [run, setRun] = useState<AutomationRunDetail | null>(null);
  /** The card whose panel is open; undefined until the run first loads. */
  const [selected, setSelected] = useState<string | null>();
  /** The Chat of an agent step, open in place of the run. */
  const [chat, setChat] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      automationsClient.run(id).then((loaded) => {
        setRun(loaded);
        // A run that failed opens on why. Later changes leave the panel alone.
        setSelected((current) =>
          current === undefined
            ? (loaded.steps.find((step) => step.status === "failed")?.step_id ??
              null)
            : current,
        );
      }, onFail),
    [id, onFail],
  );
  useEffect(() => void load(), [load]);
  useOnWorkspaceChange(() => void load());

  if (chat)
    return (
      <ChatDetail
        key={chat}
        id={chat}
        notice={
          run?.steps.some((step) => step.chat_id === chat && step.chat_owned) &&
          `A run of ${automationName}. Reply to take it over; it moves to your Chats.`
        }
        expanded={expanded}
        single={single}
        onExpand={onExpand}
        onReturn={() => setChat(null)}
        onClose={() => setChat(null)}
      />
    );

  const act = <T,>(action: Promise<T>, done: (result: T) => void) => {
    setBusy(true);
    void action.then(done, onFail).finally(() => setBusy(false));
  };
  const closePanel = () => {
    const card = selected;
    setSelected(null);
    // Back to the card the panel was opened from.
    if (card)
      document
        .querySelector<HTMLElement>(`[data-flow-card="${CSS.escape(card)}"]`)
        ?.focus();
  };
  const active = run?.status === "queued" || run?.status === "running";
  const panel = run && selected && (
    <RunPanel
      run={run}
      agents={agents}
      selected={selected}
      onOpenChat={setChat}
      onClose={closePanel}
    />
  );
  return (
    <section className="ticket-detail chat-pane" aria-labelledby={headingId}>
      <div className="detail-header">
        <div className="detail-title-group">
          <IconButton label="Back to runs" onClick={onBack}>
            <ArrowLeft aria-hidden />
          </IconButton>
          <h2 id={headingId} className="chat-head-title" tabIndex={-1}>
            <span className="run-crumb">{automationName} › </span>
            {run?.ticket ? `Run on ${run.ticket.reference}` : "Run"}
          </h2>
        </div>
        <div className="detail-actions">
          {run && (
            <>
              <span className="run-status" role="status">
                <RunMark status={run.status} />
                {RUN_STATUS_LABELS[run.status]}
              </span>
              {active ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => act(automationsClient.stopRun(id), setRun)}
                >
                  <Square aria-hidden />
                  Stop
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(automationsClient.runAgain(id), (again) =>
                      onOpenRun(again.id),
                    )
                  }
                >
                  <RotateCcw aria-hidden />
                  Run again
                </Button>
              )}
            </>
          )}
          {expanded ? (
            <IconButton label="Show beside the list" onClick={onReturn}>
              <Minimize2 aria-hidden />
            </IconButton>
          ) : (
            !single && (
              <IconButton label="Expand run" onClick={onExpand}>
                <Maximize2 aria-hidden />
              </IconButton>
            )
          )}
          <IconButton label="Close Automation" onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </div>
      </div>
      {run && (
        <div className="flow-body" data-panel={panel ? undefined : "none"}>
          <RunCanvas
            run={run}
            agents={agents}
            selected={(panel && selected) || null}
            onSelect={setSelected}
          />
          {panel}
        </div>
      )}
    </section>
  );
}
