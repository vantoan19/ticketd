import { createContext, use, useEffect, useMemo, type ReactNode } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Bell,
  Bot,
  CalendarClock,
  CircleDot,
  CirclePlus,
  Ellipsis,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Split,
  SquarePen,
  Tag,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
  type FlowList,
} from "@/features/automations/canvas-layout";
import {
  startsWithoutTicket,
  type Automation,
  type AutomationAgent,
  type AutomationDefinition,
  stepPaths,
} from "@/features/automations/client";
import {
  CARD_ICONS,
  cardColor,
  cardName,
  PATH_LABEL_SHAPE,
  PATH_LABELS,
  stepCard,
  triggerCard,
  type Card,
} from "@/features/automations/flow-cards";
import { everyStep, flowSteps } from "@/features/automations/runs-model";
import type { Project } from "@/lib/api/client";

/** The triggers under "A ticket changes", in the order the menu offers them. */
const TICKET_TRIGGERS = [
  { kind: "ticket_created", label: "Ticket created", icon: CirclePlus },
  {
    kind: "ticket_updated",
    label: "Ticket updated",
    note: "Its title, description or properties change",
    icon: Pencil,
  },
  {
    kind: "status_changed",
    label: "Status changed",
    note: "To a status you choose",
    icon: CircleDot,
  },
  {
    kind: "tag_added",
    label: "Tag added",
    note: "A tag you choose is added",
    icon: Tag,
  },
  {
    kind: "tag_removed",
    label: "Tag removed",
    note: "A tag you choose is removed",
    icon: Tag,
  },
  {
    kind: "activity_created",
    label: "Update added",
    note: "Someone posts an update",
    icon: MessageSquare,
  },
] as const;
/** The triggers that start a run without a ticket, under their own heading. */
const OTHER_TRIGGERS = [
  {
    kind: "schedule",
    label: "On a schedule",
    note: "Every few hours, or at a time on the days you choose",
    icon: CalendarClock,
  },
  {
    kind: "by_hand",
    label: "When I run it",
    note: "Only when you press Run now",
    icon: Play,
  },
] as const;
/** The trigger kinds this page can set up. */
export type TriggerChoice = (
  typeof TICKET_TRIGGERS | typeof OTHER_TRIGGERS
)[number]["kind"];

/** What each path is called where a step is added on it. */
const PATH_NAMES = { ...PATH_LABELS, failure: "failure" };

/** Why a step that acts on the ticket cannot be added. */
const NEEDS_TICKET =
  "Needs a ticket, and this Automation does not start from one";

/** The step kinds this page can add and set up. */
export type StepChoice = "run_agent" | "change_ticket" | "notify" | "if";

type Actions = {
  onSelect: (id: string) => void;
  onChooseTrigger: (kind: TriggerChoice) => void;
  /**
   * Adds a step of `kind` at `index` of the steps of `list`: a path under a
   * step, or the flow's own steps when absent.
   */
  onAddStep: (index: number, kind: StepChoice, list?: FlowList) => void;
  onDeleteStep: (id: string) => void;
  /** Gives the step a failure path with nothing on it yet, or takes its path away. */
  onSetFailurePath: (id: string, on: boolean) => void;
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
        {TICKET_TRIGGERS.map(({ kind, label, icon: Icon, ...rest }) => (
          <DropdownMenuItem
            key={kind}
            className="items-start whitespace-normal"
            onSelect={() => onChooseTrigger(kind)}
          >
            <Icon aria-hidden />
            <span className="flow-menu-item-text">
              {label}
              {"note" in rest && <small>{rest.note}</small>}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Without a ticket</DropdownMenuLabel>
        {OTHER_TRIGGERS.map(({ kind, label, note, icon: Icon }) => (
          <DropdownMenuItem
            key={kind}
            className="items-start whitespace-normal"
            onSelect={() => onChooseTrigger(kind)}
          >
            <Icon aria-hidden />
            <span className="flow-menu-item-text">
              {label}
              <small>{note}</small>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type CardData = {
  card: Card;
  selected: boolean;
  needs: string | undefined;
  /**
   * How many steps are on the step's failure path; null while it has no such
   * path, and absent on a card that cannot have one.
   */
  failureSteps?: number | null;
};

function CardNode({ data }: NodeProps<Node<CardData>>) {
  const { card, selected, needs, failureSteps } = data;
  const { onSelect, onDeleteStep, onSetFailurePath } = useActions();
  const Icon = CARD_ICONS[card.icon];
  const face = (
    <>
      <span className="flow-card-icon">
        <Icon size={16} aria-hidden />
      </span>
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
        data-kind={cardColor(card)}
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
            // Delete on a step asks before it goes; the trigger stays.
            onKeyDown={(event) => {
              if (event.key === "Delete" && card.menu === "step")
                onDeleteStep(card.id);
            }}
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
                {failureSteps === null && (
                  <DropdownMenuItem
                    className="items-start whitespace-normal"
                    onSelect={() => onSetFailurePath(card.id, true)}
                  >
                    <span className="flow-menu-item-text">
                      Add failure path
                      <small>Steps that run only if this step fails</small>
                    </span>
                  </DropdownMenuItem>
                )}
                {typeof failureSteps === "number" && (
                  <DropdownMenuItem
                    onSelect={() => onSetFailurePath(card.id, false)}
                  >
                    {/* It asks first when steps would go with the path. */}
                    {failureSteps > 0
                      ? "Remove failure path…"
                      : "Remove failure path"}
                  </DropdownMenuItem>
                )}
                {failureSteps !== undefined && <DropdownMenuSeparator />}
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
      {/* The line to the next step leaves the bottom; a failure path, the side. */}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <Handle
        id="failure"
        type="source"
        position={Position.Right}
        isConnectable={false}
      />
    </>
  );
}

type AddData = {
  index: number;
  list: FlowList | undefined;
  /** What the + is called: where the step it adds goes. */
  name: string;
  end: boolean;
};

/** A place to add a step: on the line between two cards, or ending the path. */
function AddNode({ data }: NodeProps<Node<AddData>>) {
  const { onAddStep, ticketless } = useActions();
  const add = (kind: StepChoice) => onAddStep(data.index, kind, data.list);
  return (
    <>
      {data.end && (
        <Handle type="target" position={Position.Top} isConnectable={false} />
      )}
      <div className="flow-gap nodrag nopan" data-end={data.end || undefined}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Its own button: a round + that hides on a line until wanted. */}
            <button type="button" className="flow-add" aria-label={data.name}>
              <Plus size={data.end ? 16 : 14} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-70" aria-label="Add a step">
            <DropdownMenuItem
              className="items-start whitespace-normal"
              onSelect={() => add("run_agent")}
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
              onSelect={() => add("change_ticket")}
            >
              <SquarePen aria-hidden />
              <span className="flow-menu-item-text">
                Change ticket
                <small>
                  {ticketless
                    ? NEEDS_TICKET
                    : "Add or remove a tag, set the status, or post an update"}
                </small>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="items-start whitespace-normal"
              onSelect={() => add("notify")}
            >
              <Bell aria-hidden />
              <span className="flow-menu-item-text">
                Notify me
                <small>Show a desktop notification</small>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="items-start whitespace-normal"
              disabled={ticketless}
              onSelect={() => add("if")}
            >
              <Split aria-hidden />
              <span className="flow-menu-item-text">
                If
                <small>
                  {ticketless
                    ? NEEDS_TICKET
                    : "Take one path or another, depending on the ticket"}
                </small>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

const nodeTypes = { card: CardNode, add: AddNode };

/**
 * Brings the whole flow back into view when a step is added or removed, and
 * when the canvas changes width, as when a panel opens beside it: paths side
 * by side are wide.
 */
function Refit({ shape }: { shape: string }) {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  useEffect(() => {
    void fitView({ maxZoom: 1, padding: 0.2 });
  }, [shape, width, fitView]);
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
  projects,
  selected,
  only,
  notice,
  ...actions
}: {
  definition: AutomationDefinition;
  /** For the name of a project an If checks for. */
  projects: Project[];
  /** The line the conditions add to the trigger's card. */
  only?: string | undefined;
  problems: Automation["problems"];
  agents: AutomationAgent[];
  /** The card whose panel is open: a step's id, or the trigger's. */
  selected: string | null;
  /** A one-line bar across the top of the canvas. */
  notice?: ReactNode;
} & Actions) {
  const { trigger, steps } = definition;
  // Every step and every path, so that a path added with nothing on it counts.
  const shape = JSON.stringify(flowSteps(steps));
  const { nodes, edges } = useMemo(() => {
    const cards = new Map(
      [
        triggerCard(trigger, only),
        ...everyStep(steps).map((step) => stepCard(step, agents, projects)),
      ].map((card) => [card.id, card]),
    );
    // Only a step that can fail takes a failure path: not an If, not the trigger.
    const failureSteps = new Map(
      everyStep(steps)
        .filter((step) => step.kind !== "if")
        .map((step) => [step.id, stepPaths(step).on_failure?.length ?? null]),
    );
    const cardOf = (id: string) => {
      const card = cards.get(id);
      if (!card) throw new Error(`the layout placed an unknown card: ${id}`);
      return card;
    };
    const layout = layoutFlow(flowSteps(steps));
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
            ...(failureSteps.has(item.id) && {
              failureSteps: failureSteps.get(item.id) ?? null,
            }),
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
          list: item.list,
          // The first place on a path is not after its step: it is on the path.
          name:
            item.list && item.index === 0
              ? `Add a step on the ${PATH_NAMES[item.list.path]} path of ${cardName(cardOf(item.after))}`
              : `Add a step after ${cardName(cardOf(item.after))}`,
          end,
        } satisfies AddData,
      };
    });
    const edges: Edge[] = layout.edges.map(({ path, ...edge }) => ({
      ...edge,
      // A line to a path bends to reach it, and says which path it is.
      type: path ? "smoothstep" : "straight",
      focusable: false,
      ...(path && { label: PATH_LABELS[path], ...PATH_LABEL_SHAPE }),
      ...(path === "yes" && { className: "flow-edge-yes" }),
      // A failure path leaves the side of its step, dashed, so it never reads
      // as the next step.
      ...(path === "failure" && {
        sourceHandle: "failure",
        className: "flow-edge-failure",
      }),
    }));
    return { nodes, edges };
  }, [trigger, only, steps, agents, projects, problems, selected]);
  const {
    onSelect,
    onChooseTrigger,
    onAddStep,
    onDeleteStep,
    onSetFailurePath,
  } = actions;
  const ticketless = startsWithoutTicket(trigger);
  const context = useMemo(
    () => ({
      onSelect,
      onChooseTrigger,
      onAddStep,
      onDeleteStep,
      onSetFailurePath,
      ticketless,
    }),
    [
      onSelect,
      onChooseTrigger,
      onAddStep,
      onDeleteStep,
      onSetFailurePath,
      ticketless,
    ],
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
            // Let a flow with nested paths fit beside the panel.
            minZoom={0.25}
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
