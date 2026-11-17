import {
  createContext,
  use,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Background,
  BaseEdge,
  getSmoothStepPath,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
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
import { Appear } from "@/components/ui/motion";
import { StatusDot } from "@/components/ui/status-dot";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  END_SIZE,
  GAP,
  layoutFlow,
  LEAST_ZOOM,
  type FlowList,
} from "@/features/automations/canvas-layout";
import {
  type Automation,
  type AutomationAgent,
  type AutomationDefinition,
  stepPaths,
} from "@/features/automations/client";
import {
  CARD_ICONS,
  cardColor,
  cardName,
  openCard,
  PATH_LABEL_SHAPE,
  PATH_LABELS,
  stepCard,
  triggerCard,
  type Card,
} from "@/features/automations/flow-cards";
import { FlowView } from "@/features/automations/FlowView";
import {
  everyStep,
  flowSteps,
  stepPlaces,
} from "@/features/automations/runs-model";
import type { Project } from "@/lib/api/client";

/** The triggers under "A ticket changes", in the order the menu offers them. */
const TICKET_TRIGGERS = [
  { kind: "ticket_created", label: "Ticket created", icon: CirclePlus },
  {
    kind: "ticket_updated",
    label: "Ticket updated",
    note: "Its title, description, project or Plan changes",
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
    label: "Update posted",
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
  /** Where the step is on its path, such as "Yes path, step 1 of 2". */
  place: string | undefined;
  selected: boolean;
  needs: string | undefined;
  /**
   * How many steps are on the step's failure path; null while it has no such
   * path, and absent on a card that cannot have one.
   */
  failureSteps?: number | null;
  /** A step added since the flow opened: it fades up into place. */
  arrived: boolean;
};

/**
 * A step added to a flow that is open takes the shared entrance. The ones the
 * flow opened with are there already, so a flow does not replay on opening.
 */
function StepArrival({
  arrived,
  children,
}: {
  arrived: boolean;
  children: ReactNode;
}) {
  return arrived ? <Appear className="size-full">{children}</Appear> : children;
}

/**
 * A line to or from a step that just arrived: it draws along its length. Lines
 * are otherwise React Flow's own; this one only adds the drawing.
 */
export function DrawnEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps) {
  const geometry = {
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  };
  const [path, labelX, labelY] = data?.smooth
    ? getSmoothStepPath(geometry)
    : getStraightPath(geometry);
  return (
    <BaseEdge
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      label={label}
      className="ui-drawn"
      pathLength={1}
      {...(markerEnd && { markerEnd })}
      {...(style && { style })}
      {...PATH_LABEL_SHAPE}
    />
  );
}

function CardNode({ data }: NodeProps<Node<CardData>>) {
  const { card, place, selected, failureSteps } = data;
  // An empty trigger's prompt is already what it needs.
  const needs = data.needs === card.title ? undefined : data.needs;
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
            {/* Its own box, so a reason too long for the card ends in "…". */}
            <span className="flow-card-status-text">{needs}</span>
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
    // Read in order, the cards are an outline: each says where it is on its path.
    "aria-label": place ? `${cardName(card)}, ${place}` : cardName(card),
    // The whole reason, where the card has to cut it short; with a name of its
    // own, the button reads its title as its description.
    ...(needs && { title: needs }),
    "data-flow-card": card.id,
  } as const;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <StepArrival arrived={data.arrived}>
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
              onClick={() => openCard(card.id, selected, onSelect)}
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
                  <IconButton label={`Actions for ${cardName(card)}`}>
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
      </StepArrival>
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
  /** A step was added from the menu: focus goes to its panel as the menu closes. */
  const added = useRef(false);
  const add = (kind: StepChoice) => {
    added.current = true;
    onAddStep(data.index, kind, data.list);
  };
  // Not `disabled`, which the arrow keys skip: a keyboard user would never
  // hear why. It stays in reach, says it is unavailable, and does nothing.
  const unavailable = ticketless && {
    "aria-disabled": true,
    // Drawn as a disabled item is.
    "data-disabled": "",
    onSelect: (event: Event) => event.preventDefault(),
  };
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
          <DropdownMenuContent
            className="w-70"
            aria-label="Add a step"
            onCloseAutoFocus={(event) => {
              if (!added.current) return;
              // Not back to this +: on to the new step's panel, which the
              // menu took focus from while it closed.
              event.preventDefault();
              added.current = false;
              document.querySelector<HTMLElement>(".flow-panel")?.focus();
            }}
          >
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
              onSelect={() => add("change_ticket")}
              {...unavailable}
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
              onSelect={() => add("if")}
              {...unavailable}
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
const edgeTypes = { drawn: DrawnEdge };

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
  hasTicket,
  notice,
  ...actions
}: {
  definition: AutomationDefinition;
  /** Whether its runs act on a ticket; without one no step can change a ticket. */
  hasTicket: boolean;
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
  // The steps present when the flow opened do not animate; each one added
  // after that arrives (and keeps its entrance mounted, so it never replays).
  const [tracker, setTracker] = useState(() => ({
    seen: new Set(everyStep(steps).map((step) => step.id)),
    arrived: new Set<string>(),
  }));
  const added = everyStep(steps).filter((step) => !tracker.seen.has(step.id));
  if (added.length > 0)
    setTracker({
      seen: new Set([...tracker.seen, ...added.map((step) => step.id)]),
      arrived: new Set([...tracker.arrived, ...added.map((step) => step.id)]),
    });
  const { arrived } = tracker;
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
    const places = stepPlaces(steps);
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
            place: places.get(item.id),
            selected: item.id === selected,
            arrived: arrived.has(item.id),
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
      // A line to a path bends to reach it, and says which path it is. A line
      // to or from a step that just arrived draws (never a failure path's
      // dashes, which the drawing would replace).
      ...(path !== "failure" &&
      (arrived.has(edge.source) || arrived.has(edge.target))
        ? { type: "drawn", data: { smooth: !!path } }
        : { type: path ? "smoothstep" : "straight" }),
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
  }, [trigger, only, steps, agents, projects, problems, selected, arrived]);
  const {
    onSelect,
    onChooseTrigger,
    onAddStep,
    onDeleteStep,
    onSetFailurePath,
  } = actions;
  const ticketless = !hasTicket;
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
            edgeTypes={edgeTypes}
            // As far out as the zoom control goes, for an overview.
            minZoom={LEAST_ZOOM}
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
          </ReactFlow>
          {/* After the steps in the Tab order. */}
          <FlowView shape={shape} selected={selected} />
        </ReactFlowProvider>
      </ActionsContext>
    </div>
  );
}
