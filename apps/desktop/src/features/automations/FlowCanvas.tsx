import { createContext, use, useEffect, useMemo, type ReactNode } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Bot, Ellipsis, Plus, Tag, Workflow, Zap } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { folderName } from "@/features/automations/automation-text";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  END_SIZE,
  GAP,
  layoutFlow,
  TRIGGER_ID,
} from "@/features/automations/canvas-layout";
import {
  HARNESS_NAMES,
  type Automation,
  type AutomationAgent,
  type AutomationDefinition,
  type AutomationStep,
} from "@/features/automations/client";

/** The trigger kinds this page can set up. */
export type TriggerChoice = "tag_added";

type Actions = {
  onSelect: (id: string) => void;
  onChooseTrigger: (kind: TriggerChoice) => void;
  /** Adds a Run agent step at `index` of the steps. */
  onAddStep: (index: number) => void;
  onDeleteStep: (id: string) => void;
};
const ActionsContext = createContext<Actions | null>(null);
function useActions(): Actions {
  const actions = use(ActionsContext);
  if (!actions) throw new Error("a flow node was drawn outside its canvas");
  return actions;
}

const TRIGGER_KINDS: Record<string, string> = {
  ticket_created: "When a ticket is created",
  ticket_updated: "When a ticket is updated",
  status_changed: "When the status changes",
  tag_added: "When a tag is added",
  tag_removed: "When a tag is removed",
  activity_created: "When an update is added",
  schedule: "On a schedule",
  by_hand: "By hand",
};
const STEP_KINDS: Record<AutomationStep["kind"], string> = {
  run_agent: "Run agent",
  change_ticket: "Change ticket",
  notify: "Notify me",
  if: "If",
};

type Card = {
  id: string;
  /** The small line above: what kind of card this is. */
  kind: string;
  /** What it does, in words; with `kind`, its accessible name. */
  title: string;
  /** The title as shown, when it is more than the words. */
  shown?: ReactNode;
  detail?: string;
  icon: "trigger" | "tag" | "agent" | "step";
  /** Nothing chosen yet: the card is a prompt. */
  unset: boolean;
  /** Which menu the card carries. */
  menu: "choose-trigger" | "change-trigger" | "step";
};

function triggerCard(trigger: AutomationDefinition["trigger"]): Card {
  if (!trigger)
    return {
      id: TRIGGER_ID,
      kind: "Trigger",
      title: "Choose what starts it",
      icon: "trigger",
      unset: true,
      menu: "choose-trigger",
    };
  const kind = TRIGGER_KINDS[trigger.kind] ?? "Trigger";
  if (trigger.kind !== "tag_added")
    return {
      id: TRIGGER_ID,
      kind: "Trigger",
      title: kind,
      icon: "trigger",
      unset: false,
      menu: "change-trigger",
    };
  const tag = trigger.tag.trim();
  return {
    id: TRIGGER_ID,
    kind,
    title: tag || "Choose a tag",
    ...(tag && {
      shown: (
        <Badge variant="tag" size="sm">
          {tag}
        </Badge>
      ),
    }),
    icon: "tag",
    unset: !tag,
    menu: "change-trigger",
  };
}

function stepCard(step: AutomationStep, agents: AutomationAgent[]): Card {
  const kind = STEP_KINDS[step.kind];
  if (step.kind !== "run_agent")
    return {
      id: step.id,
      kind,
      title: "Set up in a later version",
      icon: "step",
      unset: false,
      menu: "step",
    };
  const agent = agents.find((item) => item.id === step.agent_id);
  const where = step.execution_folder
    ? `in ${folderName(step.execution_folder)}`
    : null;
  return {
    id: step.id,
    kind,
    title: agent ? agent.name.trim() || "New agent" : "Choose an agent",
    ...(agent && {
      detail: [HARNESS_NAMES[agent.harness], where].filter(Boolean).join(" · "),
    }),
    icon: "agent",
    unset: !agent,
    menu: "step",
  };
}

const cardName = (card: Card) => `${card.kind}: ${card.title}`;

function TriggerMenu({ children }: { children: ReactNode }) {
  const { onChooseTrigger } = useActions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-70"
        aria-label="What starts it"
      >
        <DropdownMenuLabel>A ticket changes</DropdownMenuLabel>
        <DropdownMenuItem
          className="items-start whitespace-normal"
          onSelect={() => onChooseTrigger("tag_added")}
        >
          <Tag aria-hidden />
          <span className="flow-menu-item-text">
            Tag added
            <small>A tag you choose is added</small>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type CardData = { card: Card; selected: boolean; needs: string | undefined };

function CardNode({ data }: NodeProps<Node<CardData>>) {
  const { card, selected, needs } = data;
  const { onSelect, onDeleteStep } = useActions();
  const Icon = { trigger: Zap, tag: Tag, agent: Bot, step: Workflow }[
    card.icon
  ];
  const face = (
    <>
      <Icon size={16} aria-hidden />
      <span className="flow-card-text">
        <span className="flow-card-kind">{card.kind}</span>
        <span className="flow-card-title">{card.shown ?? card.title}</span>
        {needs ? (
          <span className="flow-card-status">
            <StatusDot tone="attention" />
            {needs}
          </span>
        ) : (
          card.detail && <span className="flow-card-detail">{card.detail}</span>
        )}
      </span>
    </>
  );
  const main = {
    type: "button",
    className: "flow-card-main nodrag nopan",
    "aria-label": cardName(card),
    "data-flow-card": card.id,
  } as const;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        className="flow-card"
        data-selected={selected || undefined}
        data-unset={card.unset || undefined}
      >
        {card.menu === "choose-trigger" ? (
          <TriggerMenu>
            <button {...main}>{face}</button>
          </TriggerMenu>
        ) : (
          <button
            {...main}
            aria-pressed={selected}
            onClick={() => onSelect(card.id)}
          >
            {face}
          </button>
        )}
        {card.menu === "change-trigger" && (
          <span className="flow-card-menu nodrag nopan">
            <TriggerMenu>
              <IconButton label="Change what starts it">
                <Ellipsis aria-hidden />
              </IconButton>
            </TriggerMenu>
          </span>
        )}
        {card.menu === "step" && (
          <span className="flow-card-menu nodrag nopan">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Step actions">
                  <Ellipsis aria-hidden />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" aria-label="Step actions">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onDeleteStep(card.id)}
                >
                  Delete step…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

type AddData = { index: number; after: string; end: boolean };

/** A place to add a step: on the line between two cards, or ending the path. */
function AddNode({ data }: NodeProps<Node<AddData>>) {
  const { onAddStep } = useActions();
  return (
    <>
      {data.end && (
        <Handle type="target" position={Position.Top} isConnectable={false} />
      )}
      <div className="flow-gap nodrag nopan" data-end={data.end || undefined}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Its own button: a round + that hides on a line until wanted. */}
            <button
              type="button"
              className="flow-add"
              aria-label={`Add a step after ${data.after}`}
            >
              <Plus size={data.end ? 16 : 14} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-70" aria-label="Add a step">
            <DropdownMenuItem
              className="items-start whitespace-normal"
              onSelect={() => onAddStep(data.index)}
            >
              <Bot aria-hidden />
              <span className="flow-menu-item-text">
                Run agent
                <small>Start a Chat with one of your agents</small>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

const nodeTypes = { card: CardNode, add: AddNode };

/** Brings the whole flow back into view when a step is added or removed. */
function Refit({ shape }: { shape: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    void fitView({ maxZoom: 1, padding: 0.2 });
  }, [shape, fitView]);
  return null;
}

/**
 * An Automation's steps as a diagram, arranged by `layoutFlow`: nothing is
 * dragged or wired by hand. Cards and + buttons are ordinary buttons in the
 * order the steps run, so Tab walks the flow.
 */
export function FlowCanvas({
  definition,
  problems,
  agents,
  selected,
  ...actions
}: {
  definition: AutomationDefinition;
  problems: Automation["problems"];
  agents: AutomationAgent[];
  /** The card whose panel is open: a step's id, or the trigger's. */
  selected: string | null;
} & Actions) {
  const { trigger, steps } = definition;
  const shape = steps.map((step) => step.id).join(" ");
  const { nodes, edges } = useMemo(() => {
    const cards = new Map(
      [
        triggerCard(trigger),
        ...steps.map((step) => stepCard(step, agents)),
      ].map((card) => [card.id, card]),
    );
    const cardOf = (id: string) => {
      const card = cards.get(id);
      if (!card) throw new Error(`the layout placed an unknown card: ${id}`);
      return card;
    };
    const layout = layoutFlow(steps.map((step) => step.id));
    const nodes: Node[] = layout.items.map((item) => {
      const position = { x: item.x, y: item.y };
      if (item.kind === "card")
        return {
          id: item.id,
          type: "card",
          position,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          data: {
            card: cardOf(item.id),
            selected: item.id === selected,
            needs: problems.find((problem) => problem.step_id === item.id)
              ?.message,
          } satisfies CardData,
        };
      const end = item.kind === "end";
      return {
        id: item.id,
        type: "add",
        position,
        width: end ? END_SIZE : CARD_WIDTH,
        height: end ? END_SIZE : GAP,
        data: {
          index: item.index,
          after: cardName(cardOf(item.after)),
          end,
        } satisfies AddData,
      };
    });
    const edges: Edge[] = layout.edges.map((edge) => ({
      ...edge,
      type: "straight",
      focusable: false,
    }));
    return { nodes, edges };
  }, [trigger, steps, agents, problems, selected]);
  const { onSelect, onChooseTrigger, onAddStep, onDeleteStep } = actions;
  const context = useMemo(
    () => ({ onSelect, onChooseTrigger, onAddStep, onDeleteStep }),
    [onSelect, onChooseTrigger, onAddStep, onDeleteStep],
  );
  return (
    <div className="flow-canvas">
      <ActionsContext value={context}>
        <ReactFlowProvider>
          <ReactFlow
            aria-label="Steps"
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            maxZoom={1.5}
            panOnScroll
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Refit shape={shape} />
          </ReactFlow>
        </ReactFlowProvider>
      </ActionsContext>
    </div>
  );
}
