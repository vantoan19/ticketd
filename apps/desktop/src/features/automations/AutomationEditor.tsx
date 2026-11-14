import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  Bell,
  Bot,
  Ellipsis,
  Maximize2,
  Minimize2,
  Split,
  SquarePen,
  X,
} from "lucide-react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { AgentForm } from "@/features/automations/AgentForm";
import {
  TRIGGER_ID,
  type FlowList,
} from "@/features/automations/canvas-layout";
import {
  automationsClient,
  definitionOf,
  editSteps,
  startsWithoutTicket,
  stepPaths,
  type Automation,
  type AutomationAgent,
  type AutomationAgentSettings,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationStep,
  type AutomationTrigger,
} from "@/features/automations/client";
import { conditionsLine } from "@/features/automations/automation-text";
import {
  CARD_ICONS,
  focusCard,
  TRIGGER_KINDS,
  triggerCard,
} from "@/features/automations/flow-cards";
import {
  FlowCanvas,
  type StepChoice,
  type TriggerChoice,
} from "@/features/automations/FlowCanvas";
import {
  ChangeTicketFields,
  NotifyFields,
} from "@/features/automations/TicketStepFields";
import { IfFields } from "@/features/automations/IfFields";
import { everyStep } from "@/features/automations/runs-model";
import { RunsList } from "@/features/automations/RunsList";
import { RunView } from "@/features/automations/RunView";
import { RunAgentFields, StepPanel } from "@/features/automations/StepPanel";
import {
  ConditionRows,
  TriggerFields,
} from "@/features/automations/TriggerPanel";
import { client, type Project } from "@/lib/api/client";

/** Each trigger as it is when first chosen, before anything is set on it. */
const NEW_TRIGGERS: Record<TriggerChoice, AutomationTrigger> = {
  ticket_created: { kind: "ticket_created" },
  ticket_updated: { kind: "ticket_updated" },
  status_changed: { kind: "status_changed", to: null, from: null },
  tag_added: { kind: "tag_added", tag: "" },
  tag_removed: { kind: "tag_removed", tag: "" },
  activity_created: { kind: "activity_created" },
  schedule: {
    kind: "schedule",
    schedule: { kind: "weekly", time: "09:00", weekdays: ["mon"] },
  },
  by_hand: { kind: "by_hand" },
};

/**
 * One Automation, edited in place: every change is saved as it is made. Mount
 * it with the Automation's id as `key`; it keeps the definition being edited
 * and takes only what the core derives (on or off, what is unfinished) from
 * later changes to `automation`.
 */
export function AutomationEditor({
  automation,
  agents,
  expanded,
  single,
  onExpand,
  onReturn,
  onClose,
  openRun,
  onOpenRun: setOpenRun,
  onChange,
  onSetEnabled,
  onStopAndTurnOff,
  onDuplicate,
  onDelete,
  onCreateAgent,
  onSaveAgent,
  onDeleteAgent,
  onFail,
}: {
  automation: Automation;
  agents: AutomationAgent[];
  expanded: boolean;
  single: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  /** The run open in place of the Automation; closing it returns to the runs. */
  openRun: string | null;
  onOpenRun: (id: string | null) => void;
  onChange: (definition: AutomationDefinition) => void;
  onSetEnabled: (enabled: boolean) => void;
  /** Off, with the runs in progress ended as Needs attention. */
  onStopAndTurnOff: () => void;
  /** Makes a copy, off, and opens it. */
  onDuplicate: () => void;
  onDelete: () => void;
  /** Makes a new agent; resolves to nothing when that failed. */
  onCreateAgent: () => Promise<AutomationAgent | undefined>;
  onSaveAgent: (id: string, settings: AutomationAgentSettings) => void;
  onDeleteAgent: (id: string) => void;
  onFail: (reason: unknown) => void;
}) {
  const headingId = useId();
  const [draft, setDraft] = useState(() => definitionOf(automation));
  /** The flow being edited, or what running it has done. A run returns to the runs. */
  const [view, setView] = useState<"steps" | "runs">(
    openRun ? "runs" : "steps",
  );
  /** The card whose panel is open: a step's id, or the trigger's. */
  const [selected, setSelected] = useState<string | null>(null);
  /** The name being typed in the Rename dialog; null while it is closed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletingStep, setDeletingStep] = useState<string | null>(null);
  /** The step whose failure path, which has steps, is about to be removed. */
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  /** The agent open over the editor, to set up or change. */
  const [agentOpen, setAgentOpen] = useState<string | null>(null);
  /** The runs in progress, while the person is asked how to switch off. */
  const [turningOff, setTurningOff] = useState<AutomationRun[] | null>(null);
  const onSwitch = useRef<HTMLButtonElement>(null);
  /** For the project conditions: their names, and the ones to choose from. */
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    void client.listProjects().then(setProjects, onFail);
  }, [onFail]);

  const setEnabled = (enabled: boolean) => {
    if (enabled) return onSetEnabled(true);
    // Stopping an agent is a decision: with a run in progress, ask first.
    automationsClient.runs(automation.id).then((runs) => {
      const active = runs.filter(
        (run) => run.status === "queued" || run.status === "running",
      );
      if (active.length > 0) setTurningOff(active);
      else onSetEnabled(false);
    }, onFail);
  };

  const change = (patch: Partial<AutomationDefinition>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(next);
  };
  const changeStep = (id: string, patch: Partial<AutomationStep>) =>
    change({
      steps: editSteps(draft.steps, (list) =>
        list.map((step) =>
          step.id === id ? ({ ...step, ...patch } as AutomationStep) : step,
        ),
      ),
    });
  /** Saves `steps` after some were taken out, with their paths. */
  const removeSteps = (steps: AutomationStep[]) => {
    change({ steps });
    // The open panel may be of a step that went.
    if (
      selected !== TRIGGER_ID &&
      !everyStep(steps).some((item) => item.id === selected)
    )
      setSelected(null);
  };
  const failurePath = (id: string | null) => {
    const owner = everyStep(draft.steps).find((item) => item.id === id);
    return (owner && stepPaths(owner).on_failure) ?? [];
  };
  const removeFailurePath = (id: string) =>
    removeSteps(
      editSteps(draft.steps, (list) =>
        list.map((item) =>
          item.id === id ? { ...item, on_failure: null } : item,
        ),
      ),
    );
  const setFailurePath = (id: string, on: boolean) => {
    if (on) changeStep(id, { on_failure: [] });
    // Steps go with the path, so ask first when it has any.
    else if (failurePath(id).length > 0) setRemovingPath(id);
    else removeFailurePath(id);
  };
  const chooseTrigger = (kind: TriggerChoice) => {
    // Choosing the kind it already has keeps what was set on it.
    if (draft.trigger?.kind !== kind) {
      const trigger = NEW_TRIGGERS[kind];
      change({
        trigger,
        // Conditions are about a ticket; a run that has none could match nothing.
        ...(startsWithoutTicket(trigger) && { conditions: [] }),
      });
    }
    setSelected(TRIGGER_ID);
  };
  const runNow = () =>
    // The run it queues is where the person looks next.
    automationsClient.runNow(automation.id).then(() => setView("runs"), onFail);
  const addStep = (index: number, kind: StepChoice, list?: FlowList) => {
    const id = crypto.randomUUID();
    const step = (after: AutomationStep[]): AutomationStep =>
      kind === "if"
        ? // Paths never rejoin, so nothing can follow an If: the steps that
          // came after this place go on down its Yes path.
          { id, kind, checks: [], yes: after, no: [] }
        : kind === "change_ticket"
          ? {
              id,
              kind,
              change: { action: "add_tag", tag: "" },
              on_failure: null,
            }
          : kind === "notify"
            ? {
                id,
                kind,
                text: "",
                // Without a ticket there is only the run to open.
                opens: startsWithoutTicket(draft.trigger) ? "run" : "ticket",
                on_failure: null,
              }
            : {
                id,
                kind,
                agent_id: null,
                execution_folder: null,
                on_failure: null,
              };
    change({
      steps: editSteps(draft.steps, (steps, owner) => {
        if (owner?.step !== list?.step || owner?.path !== list?.path)
          return steps;
        const after = steps.slice(index);
        return [
          ...steps.slice(0, index),
          step(after),
          ...(kind === "if" ? [] : after),
        ];
      }),
    });
    setSelected(id);
  };
  const closePanel = () => {
    const card = selected;
    setSelected(null);
    // Back to the card the panel was opened from.
    if (card) focusCard(card);
  };

  const title = draft.name.trim() || "New Automation";
  if (openRun)
    return (
      <RunView
        key={openRun}
        id={openRun}
        automationName={title}
        agents={agents}
        expanded={expanded}
        single={single}
        onExpand={onExpand}
        onReturn={onReturn}
        onClose={onClose}
        onBack={() => setOpenRun(null)}
        onOpenRun={setOpenRun}
        onFail={onFail}
      />
    );
  const left = automation.problems.length;
  const step = everyStep(draft.steps).find((item) => item.id === selected);
  const openAgent = agents.find((agent) => agent.id === agentOpen);
  const trigger = draft.trigger;
  const TriggerIcon = CARD_ICONS[triggerCard(trigger).icon];
  const panel =
    selected === TRIGGER_ID && trigger && trigger.kind in NEW_TRIGGERS ? (
      <StepPanel
        key={selected}
        title={TRIGGER_KINDS[trigger.kind]}
        icon={<TriggerIcon size={16} aria-hidden />}
        onClose={closePanel}
      >
        <TriggerFields
          trigger={trigger}
          onChange={(next) => change({ trigger: next })}
        />
        {!startsWithoutTicket(trigger) && (
          <ConditionRows
            conditions={draft.conditions}
            projects={projects}
            onChange={(conditions) => change({ conditions })}
          />
        )}
      </StepPanel>
    ) : step?.kind === "run_agent" ? (
      <StepPanel
        key={step.id}
        title="Run agent"
        icon={<Bot size={16} aria-hidden />}
        onClose={closePanel}
        onDelete={() => setDeletingStep(step.id)}
      >
        <RunAgentFields
          agentId={step.agent_id}
          folder={step.execution_folder}
          agents={agents}
          onChange={(patch) => changeStep(step.id, patch)}
          onNewAgent={() =>
            void onCreateAgent().then((agent) => {
              if (!agent) return;
              changeStep(step.id, { agent_id: agent.id });
              setAgentOpen(agent.id);
            })
          }
          onEditAgent={setAgentOpen}
          onFail={onFail}
        />
      </StepPanel>
    ) : step?.kind === "change_ticket" ? (
      <StepPanel
        key={step.id}
        title="Change ticket"
        icon={<SquarePen size={16} aria-hidden />}
        onClose={closePanel}
        onDelete={() => setDeletingStep(step.id)}
      >
        <ChangeTicketFields
          change={step.change ?? { action: "add_tag", tag: "" }}
          automationName={title}
          onChange={(next) => changeStep(step.id, { change: next })}
        />
      </StepPanel>
    ) : step?.kind === "notify" ? (
      <StepPanel
        key={step.id}
        title="Notify me"
        icon={<Bell size={16} aria-hidden />}
        onClose={closePanel}
        onDelete={() => setDeletingStep(step.id)}
      >
        <NotifyFields
          text={step.text}
          opens={step.opens}
          automationName={title}
          eventTag={
            draft.trigger?.kind === "tag_added" ? draft.trigger.tag : null
          }
          onChange={(patch) => changeStep(step.id, patch)}
        />
      </StepPanel>
    ) : step?.kind === "if" ? (
      <StepPanel
        key={step.id}
        title="If"
        icon={<Split size={16} aria-hidden />}
        onClose={closePanel}
        onDelete={() => setDeletingStep(step.id)}
      >
        <IfFields
          checks={step.checks}
          projects={projects}
          onChange={(checks) => changeStep(step.id, { checks })}
        />
      </StepPanel>
    ) : null;

  return (
    <section className="ticket-detail chat-pane" aria-labelledby={headingId}>
      <div className="detail-header">
        <div className="detail-title-group">
          {single && (
            <IconButton label="Back to Automations" onClick={onReturn}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          <h2 id={headingId} className="chat-head-title" tabIndex={-1}>
            {title}
          </h2>
          <SegmentedControl
            aria-label="Show"
            value={view}
            onValueChange={setView}
            options={[
              { value: "steps", label: "Steps" },
              { value: "runs", label: "Runs" },
            ]}
          />
        </div>
        <div className="detail-actions">
          {left > 0 && (
            <span id={`${headingId}-left`} className="auto-left">
              {left === 1 ? "1 step left" : `${left} steps left`}
            </span>
          )}
          {trigger?.kind === "by_hand" ? (
            // Nothing starts it but the person, so there is nothing to switch on.
            <Button
              variant="outline"
              size="sm"
              className="mx-2"
              disabled={left > 0}
              {...(left > 0 && { "aria-describedby": `${headingId}-left` })}
              onClick={() => void runNow()}
            >
              Run now
            </Button>
          ) : (
            <label className="auto-on">
              <Switch
                aria-label="On for this desktop"
                {...(left > 0 && { "aria-describedby": `${headingId}-left` })}
                ref={onSwitch}
                checked={automation.enabled}
                disabled={left > 0 && !automation.enabled}
                onCheckedChange={setEnabled}
              />
              {automation.enabled ? "On" : "Off"}
              <TurnOffMenu
                runs={turningOff}
                onClose={() => setTurningOff(null)}
                onReturnFocus={() => onSwitch.current?.focus()}
                onTurnOff={() => onSetEnabled(false)}
                onStopAndTurnOff={onStopAndTurnOff}
              />
            </label>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Automation actions">
                <Ellipsis aria-hidden />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Automation actions">
              <DropdownMenuItem onSelect={() => setRenaming(draft.name)}>
                Rename…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onDuplicate}>
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleting(true)}
              >
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {expanded ? (
            <IconButton label="Show beside the list" onClick={onReturn}>
              <Minimize2 aria-hidden />
            </IconButton>
          ) : (
            !single && (
              <IconButton label="Expand Automation" onClick={onExpand}>
                <Maximize2 aria-hidden />
              </IconButton>
            )
          )}
          <IconButton label="Close Automation" onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </div>
      </div>
      {view === "runs" ? (
        <RunsList automation={automation} onOpen={setOpenRun} onFail={onFail} />
      ) : (
        <div className="flow-body" data-panel={panel ? undefined : "none"}>
          <FlowCanvas
            definition={draft}
            problems={automation.problems}
            agents={agents}
            projects={projects}
            selected={panel ? selected : null}
            only={conditionsLine(draft.conditions, projects)}
            onSelect={setSelected}
            onChooseTrigger={chooseTrigger}
            onAddStep={addStep}
            onDeleteStep={setDeletingStep}
            onSetFailurePath={setFailurePath}
            notice={
              automation.arrived_off && (
                <Alert size="compact" role="status">
                  <AlertTitle>Off on this desktop</AlertTitle>
                  <AlertDescription>
                    Synced from your other desktop.
                  </AlertDescription>
                  <AlertActions>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={left > 0}
                      {...(left > 0 && {
                        "aria-describedby": `${headingId}-left`,
                      })}
                      onClick={() => onSetEnabled(true)}
                    >
                      Turn on here
                    </Button>
                  </AlertActions>
                </Alert>
              )
            }
          />
          {panel}
        </div>
      )}
      <DialogShell
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename Automation"
        primaryLabel="Rename"
        blockedReason={renaming?.trim() ? null : "Give it a name."}
        width={480}
        onSubmit={() => {
          change({ name: renaming?.trim() ?? "" });
          setRenaming(null);
        }}
      >
        <Input
          aria-label="Name"
          placeholder="e.g. Triage new tickets"
          value={renaming ?? ""}
          onChange={(event) => setRenaming(event.target.value)}
        />
      </DialogShell>
      <DialogShell
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete Automation?"
        primaryLabel="Delete"
        primaryVariant="destructive"
        blockedReason={null}
        onSubmit={() => {
          setDeleting(false);
          onDelete();
        }}
      >
        <p className="chat-dialog-text">
          {title} is removed and will no longer run. This cannot be undone.
        </p>
      </DialogShell>
      <DialogShell
        open={deletingStep !== null}
        onOpenChange={(open) => !open && setDeletingStep(null)}
        title="Delete step?"
        primaryLabel="Delete"
        primaryVariant="destructive"
        blockedReason={null}
        onSubmit={() => {
          removeSteps(
            editSteps(draft.steps, (list) =>
              list.filter((item) => item.id !== deletingStep),
            ),
          );
          setDeletingStep(null);
        }}
      >
        <p className="chat-dialog-text">
          The step is removed from {title}, with anything on its paths.
        </p>
      </DialogShell>
      <DialogShell
        open={removingPath !== null}
        onOpenChange={(open) => !open && setRemovingPath(null)}
        title="Remove failure path?"
        primaryLabel="Remove"
        primaryVariant="destructive"
        blockedReason={null}
        onSubmit={() => {
          if (removingPath) removeFailurePath(removingPath);
          setRemovingPath(null);
        }}
      >
        <p className="chat-dialog-text">
          {failurePath(removingPath).length === 1
            ? "The step on it is removed"
            : `The ${failurePath(removingPath).length} steps on it are removed`}{" "}
          from {title}. If the step fails after that, the run needs attention.
        </p>
      </DialogShell>
      <Sheet
        open={openAgent !== undefined}
        onOpenChange={(open) => !open && setAgentOpen(null)}
      >
        <SheetContent
          showCloseButton={false}
          className="w-full sm:max-w-180"
          aria-describedby={undefined}
        >
          <SheetTitle className="sr-only">Agent</SheetTitle>
          {openAgent && (
            <AgentForm
              key={openAgent.id}
              agent={openAgent}
              expanded={false}
              single={false}
              onReturn={() => setAgentOpen(null)}
              onClose={() => setAgentOpen(null)}
              onSave={(settings) => onSaveAgent(openAgent.id, settings)}
              onDelete={() => {
                setAgentOpen(null);
                onDeleteAgent(openAgent.id);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

/**
 * Asked when an Automation is switched off with runs in progress. It opens
 * under the switch; closing it any other way than by a choice keeps the
 * Automation on.
 */
function TurnOffMenu({
  runs,
  onClose,
  onReturnFocus,
  onTurnOff,
  onStopAndTurnOff,
}: {
  /** The runs in progress; null while nothing is asked. */
  runs: AutomationRun[] | null;
  onClose: () => void;
  onReturnFocus: () => void;
  onTurnOff: () => void;
  onStopAndTurnOff: () => void;
}) {
  const one = runs?.length === 1;
  const reference = one ? runs[0]?.ticket?.reference : undefined;
  return (
    <DropdownMenu
      open={runs !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      {/* The switch opens the menu; this only gives it a place. */}
      <DropdownMenuTrigger asChild>
        <span className="auto-on-anchor" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        // The anchor has no name to lend the menu.
        aria-labelledby={undefined}
        aria-label="Turn off"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DropdownMenuLabel>
          {one
            ? "A run is in progress"
            : `${runs?.length ?? 0} runs are in progress`}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={onTurnOff}>
          <span className="flow-menu-item-text">
            <span>
              {one
                ? "Turn off after it finishes"
                : "Turn off after they finish"}
            </span>
            <small>
              {one
                ? `The run${reference ? ` on ${reference}` : ""} completes; no new runs start`
                : "The runs complete; no new runs start"}
            </small>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onStopAndTurnOff}>
          <span className="flow-menu-item-text">
            <span>
              {one ? "Stop it and turn off" : "Stop them and turn off"}
            </span>
            <small>
              {one
                ? "The run ends now as Needs attention"
                : "The runs end now as Needs attention"}
            </small>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Keep it on</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
