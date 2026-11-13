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
import { Bell, Bot, Ellipsis, Plus, SquarePen, Tag } from "lucide-react";
import "@xyflow/react/dist/style.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  END_SIZE,
  GAP,
  layoutFlow,
} from "@/features/automations/canvas-layout";
import type {
  Automation,
  AutomationAgent,
  AutomationDefinition,
} from "@/features/automations/client";
import {
  CARD_ICONS,
  cardName,
  stepCard,
  triggerCard,
  type Card,
} from "@/features/automations/flow-cards";

/** The trigger kinds this page can set up. */
export type TriggerChoice = "tag_added";

/** The step kinds this page can add and set up. */
export type StepChoice = "run_agent" | "change_ticket" | "notify";

type Actions = {
  onSelect: (id: string) => void;
  onChooseTrigger: (kind: TriggerChoice) => void;
  /** Adds a step of `kind` at `index` of the steps. */
  onAddStep: (index: number, kind: StepChoice) => void;
  onDeleteStep: (id: string) => void;
};
type CanvasContext = Actions & {
  /** The Automation starts without a ticket, so no step can change one. */
  ticketless: boolean;
};
const ActionsContext = createContext<CanvasContext | null>(null);
function useActions(): CanvasContext {
  const actions = use(ActionsContext);
  if (!actions) throw new Error("a flow node was drawn outside its canvas");
  return actions;
}

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
  const Icon = CARD_ICONS[card.icon];
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
  const { onAddStep, ticketless } = useActions();
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
              onSelect={() => onAddStep(data.index, "run_agent")}
            >
              <Bot aria-hidden />
              <span className="flow-menu-item-text">
                Run agent
                <small>Start a Chat with one of your agents</small>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="items-start whitespace-normal"
              disabled={ticketless}
              onSelect={() => onAddStep(data.index, "change_ticket")}
            >
              <SquarePen aria-hidden />
              <span className="flow-menu-item-text">
                Change ticket
                <small>
                  {ticketless
                    ? "Needs a ticket, and this Automation does not start from one"
                    : "Add or remove a tag, set the status, or post an update"}
                </small>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="items-start whitespace-normal"
              onSelect={() => onAddStep(data.index, "notify")}
            >
              <Bell aria-hidden />
              <span className="flow-menu-item-text">
                Notify me
                <small>Show a desktop notification</small>
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
  notice,
  ...actions
}: {
  definition: AutomationDefinition;
  problems: Automation["problems"];
  agents: AutomationAgent[];
  /** The card whose panel is open: a step's id, or the trigger's. */
  selected: string | null;
  /** A one-line bar across the top of the canvas. */
  notice?: ReactNode;
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
    const layout = layoutFlow(steps.map((step) => ({ id: step.id })));
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
  const ticketless =
    trigger?.kind === "schedule" || trigger?.kind === "by_hand";
  const context = useMemo(
    () => ({ onSelect, onChooseTrigger, onAddStep, onDeleteStep, ticketless }),
    [onSelect, onChooseTrigger, onAddStep, onDeleteStep, ticketless],
  );
  return (
    <div className="flow-canvas">
      {notice && <div className="flow-notice">{notice}</div>}
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
