import { useEffect, useMemo } from "react";
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
import { CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { StatusDot } from "@/components/ui/status-dot";
import {
  CARD_WIDTH,
  layoutFlow,
  TRIGGER_ID,
} from "@/features/automations/canvas-layout";
import type {
  AutomationAgent,
  AutomationRunDetail,
} from "@/features/automations/client";
import {
  CARD_ICONS,
  cardName,
  PATH_LABELS,
  stepCard,
  triggerCard,
  type Card,
} from "@/features/automations/flow-cards";
import {
  everyStep,
  flowSteps,
  STEP_STATE_LABELS,
  stepStates,
  type StepState,
} from "@/features/automations/runs-model";

/** A card in a run also says where the step stands, on a line of its own. */
const RUN_CARD_HEIGHT = 96;

/** The mark beside a step's status. The word is always there too. */
export function StepMark({ state }: { state: StepState }) {
  switch (state) {
    case "running":
      return (
        <LoaderCircle
          size={14}
          className="chat-spin text-status-unread"
          aria-hidden
        />
      );
    case "completed":
      return (
        <CircleCheck size={14} className="text-status-ready" aria-hidden />
      );
    case "failed":
      return <StatusDot tone="attention" />;
    case "waiting":
    case "not_run":
      return <CircleDashed size={14} aria-hidden />;
  }
}

type RunCardData = {
  card: Card;
  /** null for the trigger, which has no status. */
  state: StepState | null;
  selected: boolean;
  onSelect: (id: string) => void;
};

function RunCardNode({ data }: NodeProps<Node<RunCardData>>) {
  const { card, state, selected, onSelect } = data;
  const Icon = CARD_ICONS[card.icon];
  const label = state && STEP_STATE_LABELS[state];
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        className="flow-card"
        data-selected={selected || undefined}
        data-run={state ?? undefined}
      >
        <button
          type="button"
          className="flow-card-main nodrag nopan"
          aria-label={label ? `${cardName(card)}, ${label}` : cardName(card)}
          aria-pressed={selected}
          data-flow-card={card.id}
          onClick={() => onSelect(card.id)}
        >
          <Icon size={16} aria-hidden />
          <span className="flow-card-text">
            <span className="flow-card-kind">{card.kind}</span>
            <span className="flow-card-title">{card.shown ?? card.title}</span>
            {card.detail && (
              <span className="flow-card-detail">{card.detail}</span>
            )}
            {state && (
              <span className="flow-card-status">
                <StepMark state={state} />
                {state === "failed" ? <strong>{label}</strong> : label}
              </span>
            )}
          </span>
        </button>
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

const nodeTypes = { card: RunCardNode };

/**
 * Keeps the whole run in view. It fits again whenever the canvas changes
 * width, as when the panel opens beside it; a run's steps never change.
 */
function FitRun() {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  useEffect(() => {
    void fitView({ maxZoom: 1, padding: 0.2 });
  }, [width, fitView]);
  return null;
}

/**
 * What a run did, on the canvas its Automation is built on: every step of the
 * definition the run executes with where it stands, the steps it did not reach
 * dashed, and the lines it followed marked. Nothing here can be changed.
 */
export function RunCanvas({
  run,
  agents,
  selected,
  onSelect,
}: {
  run: AutomationRunDetail;
  agents: AutomationAgent[];
  /** The card whose panel is open: a step's id, or the trigger's. */
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const { trigger, steps } = run.definition;
    const states = stepStates(run);
    const cards = new Map([
      [TRIGGER_ID, triggerCard(trigger)],
      ...everyStep(steps).map(
        (step) => [step.id, stepCard(step, agents)] as const,
      ),
    ]);
    const layout = layoutFlow(flowSteps(steps), RUN_CARD_HEIGHT);
    const nodes: Node[] = layout.items.flatMap((item) => {
      const card = cards.get(item.id);
      if (item.kind !== "card" || !card) return [];
      return {
        id: item.id,
        type: "card",
        position: { x: item.x, y: item.y },
        width: CARD_WIDTH,
        height: RUN_CARD_HEIGHT,
        data: {
          card,
          state: states.get(item.id) ?? null,
          selected: item.id === selected,
          onSelect,
        } satisfies RunCardData,
      };
    });
    const reached = (id: string) => {
      const state = states.get(id);
      return state !== undefined && state !== "waiting" && state !== "not_run";
    };
    const edges: Edge[] = layout.edges
      // A read-only canvas has no + to end a path on.
      .filter((edge) => cards.has(edge.target))
      .map(({ id, source, target, path }) => ({
        id,
        source,
        target,
        type: path ? "smoothstep" : "straight",
        focusable: false,
        ...(path === "failure" && { sourceHandle: "failure" }),
        ...(path && { label: PATH_LABELS[path] }),
        className: [
          path === "failure" && "flow-edge-failure",
          reached(target) ? "flow-edge-taken" : "flow-edge-idle",
        ]
          .filter(Boolean)
          .join(" "),
      }));
    return { nodes, edges };
  }, [run, agents, selected, onSelect]);
  return (
    <div className="flow-canvas">
      <ReactFlowProvider>
        <ReactFlow
          aria-label="Steps"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          // A flow with paths side by side is wide: let all of it fit beside
          // the panel.
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
          <FitRun />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
