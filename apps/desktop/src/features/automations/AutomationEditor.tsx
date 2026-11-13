import { useId, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Ellipsis,
  Maximize2,
  Minimize2,
  Tag,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { AgentForm } from "@/features/automations/AgentForm";
import { TRIGGER_ID } from "@/features/automations/canvas-layout";
import {
  definitionOf,
  type Automation,
  type AutomationAgent,
  type AutomationAgentSettings,
  type AutomationDefinition,
  type AutomationStep,
} from "@/features/automations/client";
import {
  FlowCanvas,
  type TriggerChoice,
} from "@/features/automations/FlowCanvas";
import { RunsList } from "@/features/automations/RunsList";
import {
  RunAgentFields,
  StepPanel,
  TagTriggerFields,
} from "@/features/automations/StepPanel";

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
  onChange,
  onSetEnabled,
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
  onChange: (definition: AutomationDefinition) => void;
  onSetEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  /** Makes a new agent; resolves to nothing when that failed. */
  onCreateAgent: () => Promise<AutomationAgent | undefined>;
  onSaveAgent: (id: string, settings: AutomationAgentSettings) => void;
  onDeleteAgent: (id: string) => void;
  onFail: (reason: unknown) => void;
}) {
  const headingId = useId();
  const [draft, setDraft] = useState(() => definitionOf(automation));
  /** The flow being edited, or what running it has done. */
  const [view, setView] = useState<"steps" | "runs">("steps");
  /** The card whose panel is open: a step's id, or the trigger's. */
  const [selected, setSelected] = useState<string | null>(null);
  /** The name being typed in the Rename dialog; null while it is closed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletingStep, setDeletingStep] = useState<string | null>(null);
  /** The agent open over the editor, to set up or change. */
  const [agentOpen, setAgentOpen] = useState<string | null>(null);

  const change = (patch: Partial<AutomationDefinition>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(next);
  };
  const changeStep = (id: string, patch: Partial<AutomationStep>) =>
    change({
      steps: draft.steps.map((step) =>
        step.id === id ? ({ ...step, ...patch } as AutomationStep) : step,
      ),
    });
  const chooseTrigger = (kind: TriggerChoice) => {
    // Choosing the kind it already has keeps what was set on it.
    if (draft.trigger?.kind !== kind) change({ trigger: { kind, tag: "" } });
    setSelected(TRIGGER_ID);
  };
  const addStep = (index: number) => {
    const step: AutomationStep = {
      id: crypto.randomUUID(),
      kind: "run_agent",
      agent_id: null,
      execution_folder: null,
      on_failure: null,
    };
    change({
      steps: [
        ...draft.steps.slice(0, index),
        step,
        ...draft.steps.slice(index),
      ],
    });
    setSelected(step.id);
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

  const title = draft.name.trim() || "New Automation";
  const left = automation.problems.length;
  const step = draft.steps.find((item) => item.id === selected);
  const openAgent = agents.find((agent) => agent.id === agentOpen);
  const panel =
    selected === TRIGGER_ID && draft.trigger?.kind === "tag_added" ? (
      <StepPanel
        key={selected}
        title="When a tag is added"
        icon={<Tag size={16} aria-hidden />}
        onClose={closePanel}
      >
        <TagTriggerFields
          tag={draft.trigger.tag}
          onChange={(tag) => change({ trigger: { kind: "tag_added", tag } })}
        />
      </StepPanel>
    ) : step?.kind === "run_agent" ? (
      <StepPanel
        key={step.id}
        title="Run agent"
        icon={<Bot size={16} aria-hidden />}
        onClose={closePanel}
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
          <label className="auto-on">
            <Switch
              aria-label="On for this desktop"
              {...(left > 0 && { "aria-describedby": `${headingId}-left` })}
              checked={automation.enabled}
              disabled={left > 0 && !automation.enabled}
              onCheckedChange={onSetEnabled}
            />
            {automation.enabled ? "On" : "Off"}
          </label>
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
        <RunsList automation={automation} onFail={onFail} />
      ) : (
        <div className="flow-body" data-panel={panel ? undefined : "none"}>
          <FlowCanvas
            definition={draft}
            problems={automation.problems}
            agents={agents}
            selected={panel ? selected : null}
            onSelect={setSelected}
            onChooseTrigger={chooseTrigger}
            onAddStep={addStep}
            onDeleteStep={setDeletingStep}
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
          change({
            steps: draft.steps.filter((item) => item.id !== deletingStep),
          });
          if (selected === deletingStep) setSelected(null);
          setDeletingStep(null);
        }}
      >
        <p className="chat-dialog-text">
          The step is removed from {title}, with anything on its paths.
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
